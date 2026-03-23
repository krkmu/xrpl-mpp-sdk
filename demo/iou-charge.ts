/**
 * IOU Charge -- All-in-one demo
 * Creates issuer + trustlines + issues tokens, then runs MPP charge flow.
 * Run: npx tsx demo/iou-charge.ts
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { Mppx } from 'mppx/client'
import { Mppx as MppxServer, Store } from 'mppx/server'
import { Client } from 'xrpl'
import { charge as clientCharge } from '../sdk/src/client/Charge.js'
import { XRPL_EXPLORER_URLS, XRPL_RPC_URLS } from '../sdk/src/constants.js'
import { charge as serverCharge } from '../sdk/src/server/Charge.js'

const EXPLORER = XRPL_EXPLORER_URLS.testnet

async function main() {
  // -- 1. Connect to testnet and fund 3 wallets --
  console.log('[setup] Connecting to XRPL testnet...')
  const xrplClient = new Client(XRPL_RPC_URLS.testnet)
  await xrplClient.connect()

  console.log('[setup] Funding wallets (issuer, server, client)...')
  const [issuerResult, serverResult, clientResult] = await Promise.all([
    xrplClient.fundWallet(),
    xrplClient.fundWallet(),
    xrplClient.fundWallet(),
  ])
  const issuer = issuerResult.wallet
  const server = serverResult.wallet
  const client = clientResult.wallet

  // -- 2. Print all addresses --
  console.log(`[setup] Issuer:  ${issuer.classicAddress}`)
  console.log(`[setup] Server:  ${server.classicAddress}`)
  console.log(`[setup] Client:  ${client.classicAddress}`)

  // -- 3. Issuer: enable DefaultRipple (SetFlag: 8 = asfDefaultRipple) --
  console.log('\n[step 3] Issuer: AccountSet with asfDefaultRipple...')
  const accountSetResult = await xrplClient.submitAndWait(
    {
      TransactionType: 'AccountSet',
      Account: issuer.classicAddress,
      SetFlag: 8,
    },
    { wallet: issuer },
  )
  const accountSetHash = accountSetResult.result.hash
  const accountSetMeta = (accountSetResult.result.meta as any)?.TransactionResult
  console.log(`[step 3] AccountSet tx: ${accountSetHash}`)
  console.log(`[step 3] Result: ${accountSetMeta}`)
  console.log(`[step 3] Explorer: ${EXPLORER}${accountSetHash}`)

  // -- 4. Server: TrustSet to issuer for USD --
  console.log('\n[step 4] Server: TrustSet for USD (limit 1000000)...')
  const serverTrustResult = await xrplClient.submitAndWait(
    {
      TransactionType: 'TrustSet',
      Account: server.classicAddress,
      LimitAmount: {
        currency: 'USD',
        issuer: issuer.classicAddress,
        value: '1000000',
      },
    },
    { wallet: server },
  )
  const serverTrustHash = serverTrustResult.result.hash
  const serverTrustMeta = (serverTrustResult.result.meta as any)?.TransactionResult
  console.log(`[step 4] TrustSet tx: ${serverTrustHash}`)
  console.log(`[step 4] Result: ${serverTrustMeta}`)
  console.log(`[step 4] Explorer: ${EXPLORER}${serverTrustHash}`)

  // -- 5. Client: TrustSet to issuer for USD --
  console.log('\n[step 5] Client: TrustSet for USD (limit 1000000)...')
  const clientTrustResult = await xrplClient.submitAndWait(
    {
      TransactionType: 'TrustSet',
      Account: client.classicAddress,
      LimitAmount: {
        currency: 'USD',
        issuer: issuer.classicAddress,
        value: '1000000',
      },
    },
    { wallet: client },
  )
  const clientTrustHash = clientTrustResult.result.hash
  const clientTrustMeta = (clientTrustResult.result.meta as any)?.TransactionResult
  console.log(`[step 5] TrustSet tx: ${clientTrustHash}`)
  console.log(`[step 5] Result: ${clientTrustMeta}`)
  console.log(`[step 5] Explorer: ${EXPLORER}${clientTrustHash}`)

  // -- 6. Issuer: send 1000 USD to client --
  console.log('\n[step 6] Issuer: Payment of 1000 USD to client...')
  const issueResult = await xrplClient.submitAndWait(
    {
      TransactionType: 'Payment',
      Account: issuer.classicAddress,
      Destination: client.classicAddress,
      Amount: {
        currency: 'USD',
        issuer: issuer.classicAddress,
        value: '1000',
      },
    },
    { wallet: issuer },
  )
  const issueHash = issueResult.result.hash
  const issueMeta = (issueResult.result.meta as any)?.TransactionResult
  console.log(`[step 6] Payment tx: ${issueHash}`)
  console.log(`[step 6] Result: ${issueMeta}`)
  console.log(`[step 6] Explorer: ${EXPLORER}${issueHash}`)

  // -- 7. Disconnect XRPL client --
  await xrplClient.disconnect()
  console.log('\n[setup] XRPL client disconnected.')

  // -- 8. Create server charge method --
  const currencyObj = { currency: 'USD', issuer: issuer.classicAddress }
  const chargeMethod = serverCharge({
    recipient: server.classicAddress,
    currency: currencyObj,
    network: 'testnet',
    store: Store.memory(),
  })

  // -- 9. Create Mppx server --
  const mppx = MppxServer.create({
    secretKey: 'iou-demo-secret',
    methods: [chargeMethod],
  })

  // -- 10. Create handler --
  const handler = (mppx as any)['xrpl/charge']({
    amount: '10',
    currency: JSON.stringify(currencyObj),
  })

  // -- 11. Start Node HTTP server --

  function toWebRequest(req: IncomingMessage): Request {
    const host = req.headers.host ?? 'localhost:3001'
    const url = `http://${host}${req.url ?? '/'}`
    const headers = new Headers()
    for (const [key, value] of Object.entries(req.headers)) {
      if (value === undefined) continue
      if (Array.isArray(value)) {
        for (const v of value) {
          headers.append(key, v)
        }
      } else {
        headers.set(key, value)
      }
    }
    return new Request(url, {
      method: req.method ?? 'GET',
      headers,
    })
  }

  async function sendWebResponse(webRes: Response, res: ServerResponse): Promise<void> {
    res.statusCode = webRes.status
    for (const [key, value] of webRes.headers.entries()) {
      res.setHeader(key, value)
    }
    const body = await webRes.text()
    res.end(body)
  }

  const httpServer = createServer(async (req, res) => {
    const path = req.url ?? '/'
    if (path === '/' || path === '/resource') {
      const webReq = toWebRequest(req)
      const result = await handler(webReq)

      if (result.status === 402) {
        console.log(`[server] 402 ${path}`)
        await sendWebResponse(result.challenge as Response, res)
        return
      }

      console.log(`[server] 200 ${path}`)
      const payload = Response.json({
        message: 'Access granted -- paid 10 USD (IOU)',
        timestamp: new Date().toISOString(),
      })
      const finalResponse = result.withReceipt(payload) as Response
      await sendWebResponse(finalResponse, res)
      return
    }

    res.statusCode = 404
    res.end('Not found')
  })

  await new Promise<void>((resolve) => {
    httpServer.listen(3001, () => {
      console.log('[server] Listening on http://localhost:3001')
      resolve()
    })
  })

  // -- 12. Create client charge method --
  const clientMethod = clientCharge({
    seed: client.seed!,
    mode: 'pull',
    network: 'testnet',
  })

  // -- 13. Create Mppx client (patches globalThis.fetch) --
  Mppx.create({
    methods: [clientMethod],
  })

  // -- 14. Fetch the gated resource --
  console.log('\n[client] Fetching http://localhost:3001/resource ...')
  const response = await fetch('http://localhost:3001/resource')

  // -- 15. Print response and receipt --
  console.log(`[client] Response status: ${response.status}`)

  const body = await response.json()
  console.log(`[client] Body: ${JSON.stringify(body, null, 2)}`)

  // Extract receipt from response headers
  let receiptHeader: string | null = null
  for (const [key, value] of response.headers.entries()) {
    if (key.toLowerCase() === 'payment-receipt') {
      receiptHeader = value
    }
  }
  if (receiptHeader) {
    console.log(`[client] Payment-Receipt header: ${receiptHeader}`)
    // Try to extract tx hash from the receipt
    try {
      const decoded = JSON.parse(atob(receiptHeader))
      if (decoded.reference) {
        console.log(`[client] Payment tx hash: ${decoded.reference}`)
        console.log(`[client] Explorer: ${EXPLORER}${decoded.reference}`)
      }
    } catch {
      // Receipt may be in a different format
      console.log('[client] (Could not decode receipt for tx hash)')
    }
  }

  // -- 16. Cleanup and exit --
  Mppx.restore()
  httpServer.close()
  console.log('\n[done] IOU charge demo complete.')
  process.exit(0)
}

main().catch((err) => {
  console.error('[fatal]', err)
  process.exit(1)
})
