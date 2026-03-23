/**
 * IOU Charge -- All-in-one demo
 * Creates issuer + trustlines + issues tokens, then runs MPP charge flow.
 * Run: npx tsx demo/iou-charge.ts
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

const PORT = 3001

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
  log.box(['XRPL MPP Demo -- IOU Charge (all-in-one)'])
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

  log.loading('Enabling DefaultRipple on issuer...')
  const asResult = await xrpl.submitAndWait(
    { TransactionType: 'AccountSet', Account: issuer.classicAddress, SetFlag: 8 },
    { wallet: issuer },
  )
  log.success(`AccountSet: ${(asResult.result.meta as any)?.TransactionResult}`)
  log.tx(asResult.result.hash, log.explorerLink(asResult.result.hash))

  const limit = { currency: 'USD', issuer: issuer.classicAddress, value: '1000000' }

  log.loading('Creating trustline: server -> issuer...')
  const ts1 = await xrpl.submitAndWait(
    { TransactionType: 'TrustSet', Account: server.classicAddress, LimitAmount: limit },
    { wallet: server },
  )
  log.success(`TrustSet (server): ${(ts1.result.meta as any)?.TransactionResult}`)
  log.tx(ts1.result.hash, log.explorerLink(ts1.result.hash))

  log.loading('Creating trustline: client -> issuer...')
  const ts2 = await xrpl.submitAndWait(
    { TransactionType: 'TrustSet', Account: payer.classicAddress, LimitAmount: limit },
    { wallet: payer },
  )
  log.success(`TrustSet (client): ${(ts2.result.meta as any)?.TransactionResult}`)
  log.tx(ts2.result.hash, log.explorerLink(ts2.result.hash))

  log.loading('Issuing 1000 USD to client...')
  const pay = await xrpl.submitAndWait(
    {
      TransactionType: 'Payment',
      Account: issuer.classicAddress,
      Destination: payer.classicAddress,
      Amount: { currency: 'USD', issuer: issuer.classicAddress, value: '1000' },
    },
    { wallet: issuer },
  )
  log.success(`Issuance: ${(pay.result.meta as any)?.TransactionResult}`)
  log.tx(pay.result.hash, log.explorerLink(pay.result.hash))

  await xrpl.disconnect()
  log.separator()

  const currencyObj = { currency: 'USD', issuer: issuer.classicAddress }
  const currencyJson = JSON.stringify(currencyObj)

  const chargeMethod = serverCharge({
    recipient: server.classicAddress,
    currency: currencyObj,
    network: 'testnet',
    store: Store.memory(),
  })

  const mppx = Mppx.create({ secretKey: 'iou-demo-secret', methods: [chargeMethod] })
  const handler = (mppx as any)['xrpl/charge']({ amount: '10', currency: currencyJson })

  const httpServer = createServer(async (req, res) => {
    const path = req.url ?? '/'
    if (path === '/resource') {
      log.request(req.method ?? 'GET', path)
      const result = await handler(toWebRequest(req))
      if (result.status === 402) {
        log.challenge('Payment required -- 10 USD')
        log.response(402, 'challenge sent')
        await sendWebResponse(result.challenge as Response, res)
        return
      }
      log.success('IOU payment verified')
      if (result.receipt?.reference) {
        log.tx(result.receipt.reference, log.explorerLink(result.receipt.reference))
      }
      log.response(200, 'access granted')
      await sendWebResponse(
        result.withReceipt(
          Response.json({ message: 'Access granted -- paid 10 USD', content: 'Hello XRPL!' }),
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
    const body = (await response.json()) as any
    log.success(body.message)
    log.info(`Content: ${body.content}`)
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
  log.info('IOU charge demo complete.')
  process.exit(0)
}

main().catch((err) => {
  log.error(`Fatal: ${err.message}`)
  process.exit(1)
})
