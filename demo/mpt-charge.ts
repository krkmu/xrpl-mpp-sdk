/**
 * MPT Charge -- All-in-one demo
 * Creates MPT issuance + authorizes + issues tokens, then runs MPP charge flow.
 * Run: npx tsx demo/mpt-charge.ts
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

  // -- 3. Issuer: MPTokenIssuanceCreate --
  console.log('\n[step 3] Issuer: MPTokenIssuanceCreate (AssetScale: 2, tfMPTCanTransfer)...')
  const mptCreateResult = await xrplClient.submitAndWait(
    {
      TransactionType: 'MPTokenIssuanceCreate' as any,
      Account: issuer.classicAddress,
      AssetScale: 2,
      MaximumAmount: '100000000',
      // tfMPTCanTransfer = 0x00000020
      Flags: 0x00000020,
    } as any,
    { wallet: issuer },
  )
  const mptCreateHash = mptCreateResult.result.hash
  const mptCreateMeta = (mptCreateResult.result.meta as any)?.TransactionResult
  console.log(`[step 3] MPTokenIssuanceCreate tx: ${mptCreateHash}`)
  console.log(`[step 3] Result: ${mptCreateMeta}`)
  console.log(`[step 3] Explorer: ${EXPLORER}${mptCreateHash}`)

  // -- 4. Get MPT issuance ID from account_objects --
  console.log('\n[step 4] Retrieving MPTokenIssuanceID...')
  const objectsResponse = await xrplClient.request({
    command: 'account_objects',
    account: issuer.classicAddress,
    type: 'mpt_issuance',
  } as any)
  const mptId = (objectsResponse.result as any).account_objects[0].mpt_issuance_id as string
  console.log(`[step 4] MPTokenIssuanceID: ${mptId}`)

  // -- 5. (Printed above) --

  // -- 6. Server: MPTokenAuthorize --
  console.log('\n[step 6] Server: MPTokenAuthorize...')
  const serverAuthResult = await xrplClient.submitAndWait(
    {
      TransactionType: 'MPTokenAuthorize' as any,
      Account: server.classicAddress,
      MPTokenIssuanceID: mptId,
    } as any,
    { wallet: server },
  )
  const serverAuthHash = serverAuthResult.result.hash
  const serverAuthMeta = (serverAuthResult.result.meta as any)?.TransactionResult
  console.log(`[step 6] MPTokenAuthorize tx: ${serverAuthHash}`)
  console.log(`[step 6] Result: ${serverAuthMeta}`)
  console.log(`[step 6] Explorer: ${EXPLORER}${serverAuthHash}`)

  // -- 7. Client: MPTokenAuthorize --
  console.log('\n[step 7] Client: MPTokenAuthorize...')
  const clientAuthResult = await xrplClient.submitAndWait(
    {
      TransactionType: 'MPTokenAuthorize' as any,
      Account: client.classicAddress,
      MPTokenIssuanceID: mptId,
    } as any,
    { wallet: client },
  )
  const clientAuthHash = clientAuthResult.result.hash
  const clientAuthMeta = (clientAuthResult.result.meta as any)?.TransactionResult
  console.log(`[step 7] MPTokenAuthorize tx: ${clientAuthHash}`)
  console.log(`[step 7] Result: ${clientAuthMeta}`)
  console.log(`[step 7] Explorer: ${EXPLORER}${clientAuthHash}`)

  // -- 8. Issuer: Payment of 10000 MPT to client --
  console.log('\n[step 8] Issuer: Payment of 10000 MPT to client...')
  const mptPayResult = await xrplClient.submitAndWait(
    {
      TransactionType: 'Payment',
      Account: issuer.classicAddress,
      Destination: client.classicAddress,
      Amount: {
        mpt_issuance_id: mptId,
        value: '10000',
      } as any,
    } as any,
    { wallet: issuer },
  )
  const mptPayHash = mptPayResult.result.hash
  const mptPayMeta = (mptPayResult.result.meta as any)?.TransactionResult
  console.log(`[step 8] Payment tx: ${mptPayHash}`)
  console.log(`[step 8] Result: ${mptPayMeta}`)
  console.log(`[step 8] Explorer: ${EXPLORER}${mptPayHash}`)

  // -- 9. Disconnect XRPL client --
  await xrplClient.disconnect()
  console.log('\n[setup] XRPL client disconnected.')

  // -- 10. Create server charge method --
  const currencyObj = { mpt_issuance_id: mptId }
  const chargeMethod = serverCharge({
    recipient: server.classicAddress,
    currency: currencyObj,
    network: 'testnet',
    store: Store.memory(),
  })

  // -- 11. Create Mppx server and handler, start HTTP server --
  const mppx = MppxServer.create({
    secretKey: 'mpt-demo-secret',
    methods: [chargeMethod],
  })

  const handler = (mppx as any)['xrpl/charge']({
    amount: '100',
    currency: JSON.stringify(currencyObj),
  })

  function toWebRequest(req: IncomingMessage): Request {
    const host = req.headers.host ?? 'localhost:3002'
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
        message: 'Access granted -- paid 100 MPT',
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
    httpServer.listen(3002, () => {
      console.log('[server] Listening on http://localhost:3002')
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
  console.log('\n[client] Fetching http://localhost:3002/resource ...')
  const response = await fetch('http://localhost:3002/resource')

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
  console.log('\n[done] MPT charge demo complete.')
  process.exit(0)
}

main().catch((err) => {
  console.error('[fatal]', err)
  process.exit(1)
})
