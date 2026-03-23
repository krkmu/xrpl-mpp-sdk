/**
 * MPT Charge -- All-in-one demo
 * Creates MPT issuance + authorizes + issues tokens, then runs MPP charge flow.
 * Run: npx tsx demo/mpt-charge.ts
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { Receipt } from 'mppx'
import { Mppx as ClientMppx } from 'mppx/client'
import { Mppx, Store } from 'mppx/server'
import { Client } from 'xrpl'
import { charge as clientCharge } from '../sdk/src/client/Charge.js'
import { XRPL_RPC_URLS } from '../sdk/src/constants.js'
import { charge as serverCharge } from '../sdk/src/server/Charge.js'
import * as log from './log.js'

const PORT = 3002

function toWebRequest(req: IncomingMessage): Request {
  const host = req.headers.host ?? `localhost:${PORT}`
  const url = `http://${host}${req.url ?? '/'}`
  const headers = new Headers()
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue
    if (Array.isArray(v)) {
      for (const val of v) headers.append(k, val)
    } else {
      headers.set(k, v)
    }
  }
  return new Request(url, { method: req.method ?? 'GET', headers })
}

async function sendWebResponse(webRes: Response, res: ServerResponse): Promise<void> {
  res.statusCode = webRes.status
  for (const [k, v] of webRes.headers.entries()) res.setHeader(k, v)
  res.end(await webRes.text())
}

async function main() {
  log.box(['XRPL MPP Demo -- MPT Charge (all-in-one)'])
  log.separator()

  log.loading('Connecting to XRPL testnet...')
  const xrpl = new Client(XRPL_RPC_URLS.testnet)
  await xrpl.connect()

  log.loading('Funding 3 wallets (issuer, server, client)...')
  const { wallet: issuer } = await xrpl.fundWallet()
  const { wallet: server } = await xrpl.fundWallet()
  const { wallet: payer } = await xrpl.fundWallet()

  log.wallet('Issuer', issuer.classicAddress)
  log.wallet('Server', server.classicAddress)
  log.wallet('Client', payer.classicAddress)
  log.separator()

  log.loading('Creating MPTokenIssuance...')
  const createResult = await xrpl.submitAndWait(
    {
      TransactionType: 'MPTokenIssuanceCreate' as any,
      Account: issuer.classicAddress,
      AssetScale: 2,
      MaximumAmount: '100000000',
      Flags: 0x00000020,
    },
    { wallet: issuer },
  )
  log.success(`MPTokenIssuanceCreate: ${(createResult.result.meta as any)?.TransactionResult}`)
  log.tx(createResult.result.hash, log.explorerLink(createResult.result.hash))

  const objs = await xrpl.request({
    command: 'account_objects',
    account: issuer.classicAddress,
    type: 'mpt_issuance',
  } as any)
  const mptId = (objs.result as any).account_objects[0].mpt_issuance_id
  log.key('MPTokenIssuanceID', mptId)

  log.loading('Authorizing server for MPT...')
  const auth1 = await xrpl.submitAndWait(
    {
      TransactionType: 'MPTokenAuthorize' as any,
      Account: server.classicAddress,
      MPTokenIssuanceID: mptId,
    },
    { wallet: server },
  )
  log.success(`MPTokenAuthorize (server): ${(auth1.result.meta as any)?.TransactionResult}`)
  log.tx(auth1.result.hash, log.explorerLink(auth1.result.hash))

  log.loading('Authorizing client for MPT...')
  const auth2 = await xrpl.submitAndWait(
    {
      TransactionType: 'MPTokenAuthorize' as any,
      Account: payer.classicAddress,
      MPTokenIssuanceID: mptId,
    },
    { wallet: payer },
  )
  log.success(`MPTokenAuthorize (client): ${(auth2.result.meta as any)?.TransactionResult}`)
  log.tx(auth2.result.hash, log.explorerLink(auth2.result.hash))

  log.loading('Issuing 10000 MPT to client...')
  const pay = await xrpl.submitAndWait(
    {
      TransactionType: 'Payment',
      Account: issuer.classicAddress,
      Destination: payer.classicAddress,
      Amount: { mpt_issuance_id: mptId, value: '10000' } as any,
    },
    { wallet: issuer },
  )
  log.success(`Issuance: ${(pay.result.meta as any)?.TransactionResult}`)
  log.tx(pay.result.hash, log.explorerLink(pay.result.hash))

  await xrpl.disconnect()
  log.separator()

  const currencyJson = JSON.stringify({ mpt_issuance_id: mptId })
  const chargeMethod = serverCharge({
    recipient: server.classicAddress,
    currency: { mpt_issuance_id: mptId },
    network: 'testnet',
    store: Store.memory(),
  })

  const mppx = Mppx.create({ secretKey: 'mpt-demo-secret', methods: [chargeMethod] })
  const handler = (mppx as any)['xrpl/charge']({ amount: '100', currency: currencyJson })

  const httpServer = createServer(async (req, res) => {
    const path = req.url ?? '/'
    if (path === '/resource') {
      log.request(req.method ?? 'GET', path)
      const result = await handler(toWebRequest(req))
      if (result.status === 402) {
        log.challenge('Payment required -- 100 MPT')
        log.response(402, 'challenge sent')
        await sendWebResponse(result.challenge as Response, res)
        return
      }
      log.success('MPT payment verified')
      if (result.receipt?.reference) {
        log.tx(result.receipt.reference, log.explorerLink(result.receipt.reference))
      }
      log.response(200, 'access granted')
      await sendWebResponse(
        result.withReceipt(
          Response.json({ message: 'Access granted -- paid 100 MPT' }),
        ) as Response,
        res,
      )
      return
    }
    res.statusCode = 404
    res.end('Not found')
  })

  await new Promise<void>((resolve) => httpServer.listen(PORT, resolve))
  log.server(`Server listening on http://localhost:${PORT}`)

  const clientMethod = clientCharge({ seed: payer.seed!, mode: 'pull', network: 'testnet' })
  ClientMppx.create({ methods: [clientMethod] })

  log.loading(`Requesting http://localhost:${PORT}/resource...`)
  const response = await fetch(`http://localhost:${PORT}/resource`)

  if (response.ok) {
    const body = await response.json()
    log.success((body as any).message)
    const receiptHeader = response.headers.get('Payment-Receipt')
    if (receiptHeader) {
      const receipt = Receipt.deserialize(receiptHeader)
      log.tx(receipt.reference, log.explorerLink(receipt.reference))
    }
  } else {
    log.error(`Failed: ${response.status} ${await response.text()}`)
  }

  httpServer.close()
  log.separator()
  log.info('MPT charge demo complete.')
  process.exit(0)
}

main().catch((err) => {
  log.error(`Fatal: ${err.message}`)
  process.exit(1)
})
