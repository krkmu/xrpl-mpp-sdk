/**
 * Cross-issuer IOU Charge -- All-in-one demo
 *
 * Setup:
 *   - issuerA emits USD.A
 *   - issuerB emits USD.B
 *   - market maker (MM) trusts both issuers and posts a parity offer
 *     bridging USD.A <-> USD.B
 *   - sender holds USD.A only
 *   - recipient holds USD.B only
 *
 * The SDK auto-resolves the path via ripple_path_find, attaches Paths +
 * SendMax (with the default 0.5% slippage buffer), and the recipient is
 * credited with USD.B even though sender never holds USD.B directly.
 *
 * Run: npx tsx demo/iou-cross-issuer.ts
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { Receipt } from 'mppx'
import { Mppx as ClientMppx } from 'mppx/client'
import { Mppx, Store } from 'mppx/server'
import { Client, type Wallet } from 'xrpl'
import { charge as clientCharge } from '../sdk/src/client/Charge.js'
import { XRPL_EXPLORER_URLS, XRPL_RPC_URLS } from '../sdk/src/constants.js'
import { charge as serverCharge } from '../sdk/src/server/Charge.js'
import * as log from './log.js'

const PORT = 3003
// Cross-issuer routing relies on the rippled `ripple_path_find` indexer.
// Devnet's indexer surfaces freshly-created orderbooks within a few seconds;
// public testnet's is materially slower and frequently returns empty until
// the offer ages by ~minutes. For a self-contained one-command demo we use
// devnet so the run finishes in under a minute.
const NETWORK = 'devnet'

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

function explorer(hash: string): string {
  return `${XRPL_EXPLORER_URLS[NETWORK]}${hash}`
}

async function submit(xrpl: Client, wallet: Wallet, tx: any, label: string) {
  const r = await xrpl.submitAndWait(tx, { wallet })
  const meta = r.result.meta as any
  if (meta?.TransactionResult !== 'tesSUCCESS') {
    throw new Error(`${label} failed: ${meta?.TransactionResult ?? 'unknown'}`)
  }
  log.tx(r.result.hash, explorer(r.result.hash))
  return r.result.hash
}

async function readUsdBalance(xrpl: Client, account: string, issuer: string): Promise<string> {
  const r = await xrpl.request({ command: 'account_lines', account, peer: issuer })
  const line = (r.result.lines as any[]).find((l) => l.currency === 'USD')
  return line?.balance ?? '0'
}

async function main() {
  log.box(['XRPL MPP Demo -- Cross-issuer IOU Charge'])
  log.separator()

  log.loading(`Connecting to XRPL ${NETWORK}...`)
  const xrpl = new Client(XRPL_RPC_URLS[NETWORK], { timeout: 60_000 })
  await xrpl.connect()

  log.loading('Funding 5 wallets (issuerA, issuerB, MM, sender, recipient)...')
  const [issuerA, issuerB, mm, sender, recipient] = await Promise.all([
    xrpl.fundWallet(),
    xrpl.fundWallet(),
    xrpl.fundWallet(),
    xrpl.fundWallet(),
    xrpl.fundWallet(),
  ]).then((rs) => rs.map((r) => r.wallet))

  log.wallet('IssuerA  ', issuerA.classicAddress)
  log.wallet('IssuerB  ', issuerB.classicAddress)
  log.wallet('Market mkr', mm.classicAddress)
  log.wallet('Sender   ', sender.classicAddress)
  log.wallet('Recipient', recipient.classicAddress)
  log.separator()

  log.loading('Enabling DefaultRipple on issuerA, issuerB, and MM...')
  for (const w of [issuerA, issuerB, mm]) {
    await submit(
      xrpl,
      w,
      { TransactionType: 'AccountSet', Account: w.classicAddress, SetFlag: 8 },
      'AccountSet',
    )
  }

  log.loading('Setting up trustlines...')
  // MM trusts both issuers
  await submit(
    xrpl,
    mm,
    {
      TransactionType: 'TrustSet',
      Account: mm.classicAddress,
      LimitAmount: { currency: 'USD', issuer: issuerA.classicAddress, value: '10000' },
    },
    'TrustSet (mm->issuerA)',
  )
  await submit(
    xrpl,
    mm,
    {
      TransactionType: 'TrustSet',
      Account: mm.classicAddress,
      LimitAmount: { currency: 'USD', issuer: issuerB.classicAddress, value: '10000' },
    },
    'TrustSet (mm->issuerB)',
  )
  // Sender trusts issuerA only
  await submit(
    xrpl,
    sender,
    {
      TransactionType: 'TrustSet',
      Account: sender.classicAddress,
      LimitAmount: { currency: 'USD', issuer: issuerA.classicAddress, value: '10000' },
    },
    'TrustSet (sender->issuerA)',
  )
  // Recipient trusts issuerB only
  await submit(
    xrpl,
    recipient,
    {
      TransactionType: 'TrustSet',
      Account: recipient.classicAddress,
      LimitAmount: { currency: 'USD', issuer: issuerB.classicAddress, value: '10000' },
    },
    'TrustSet (recipient->issuerB)',
  )

  log.loading('Issuers fund MM with 5000 USD on each side...')
  await submit(
    xrpl,
    issuerA,
    {
      TransactionType: 'Payment',
      Account: issuerA.classicAddress,
      Destination: mm.classicAddress,
      Amount: { currency: 'USD', issuer: issuerA.classicAddress, value: '5000' },
    },
    'Payment (issuerA->mm)',
  )
  await submit(
    xrpl,
    issuerB,
    {
      TransactionType: 'Payment',
      Account: issuerB.classicAddress,
      Destination: mm.classicAddress,
      Amount: { currency: 'USD', issuer: issuerB.classicAddress, value: '5000' },
    },
    'Payment (issuerB->mm)',
  )

  log.loading('Sender receives 200 USD.A from issuerA...')
  await submit(
    xrpl,
    issuerA,
    {
      TransactionType: 'Payment',
      Account: issuerA.classicAddress,
      Destination: sender.classicAddress,
      Amount: { currency: 'USD', issuer: issuerA.classicAddress, value: '200' },
    },
    'Payment (issuerA->sender)',
  )

  log.loading('MM places parity offer bridging USD.A -> USD.B (1:1)...')
  await submit(
    xrpl,
    mm,
    {
      TransactionType: 'OfferCreate',
      Account: mm.classicAddress,
      // MM gives USD.B in exchange for receiving USD.A
      TakerGets: { currency: 'USD', issuer: issuerB.classicAddress, value: '500' },
      TakerPays: { currency: 'USD', issuer: issuerA.classicAddress, value: '500' },
    },
    'OfferCreate',
  )

  // Give the path indexer a moment to pick up the new offer. Testnet's path
  // finder is fed asynchronously and can take several seconds to surface a
  // freshly-created order book. Skipping this means the first ripple_path_find
  // calls return zero alternatives.
  log.loading('Waiting for path indexer to surface the new offer...')
  await new Promise((r) => setTimeout(r, 6_000))

  log.separator()

  // Snapshot pre-payment balances for the realised-slippage report.
  const senderUsdABefore = await readUsdBalance(xrpl, sender.classicAddress, issuerA.classicAddress)
  const recipientUsdBBefore = await readUsdBalance(
    xrpl,
    recipient.classicAddress,
    issuerB.classicAddress,
  )

  // Recipient's currency is USD.B. The challenge advertises that.
  const destCurrency = { currency: 'USD', issuer: issuerB.classicAddress }
  const destCurrencyJson = JSON.stringify(destCurrency)
  const desiredAmount = '10' // 10 USD.B delivered to recipient

  const chargeMethod = serverCharge({
    recipient: recipient.classicAddress,
    currency: destCurrency,
    network: NETWORK,
    store: Store.memory(),
  })

  const mppx = Mppx.create({ secretKey: 'cross-issuer-demo-secret', methods: [chargeMethod] })
  const handler = mppx['xrpl/charge']({
    amount: desiredAmount,
    currency: destCurrencyJson,
  })

  const httpServer = createServer(async (req, res) => {
    const path = req.url ?? '/'
    if (path === '/resource') {
      log.request(req.method ?? 'GET', path)
      const result = await handler(toWebRequest(req))
      if (result.status === 402) {
        log.challenge(`Payment required -- ${desiredAmount} USD.B from issuerB`)
        log.response(402, 'challenge sent')
        await sendWebResponse(result.challenge as Response, res)
        return
      }
      log.success('Cross-issuer payment verified')
      if (result.receipt?.reference) {
        log.tx(result.receipt.reference, explorer(result.receipt.reference))
      }
      log.response(200, 'access granted')
      await sendWebResponse(
        result.withReceipt(
          Response.json({
            message: `Access granted -- paid ${desiredAmount} USD.B (sender held only USD.A)`,
            content: 'Hello cross-issuer XRPL!',
          }),
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

  // Set up the client. Default slippage 50 bps. The onProgress callback
  // captures the path-find resolution so we can print "source amount actually
  // debited" later.
  let resolved: { strategy?: string; sourceAmountValue?: string; sourceAmountCurrency?: string } =
    {}
  const clientMethod = clientCharge({
    seed: sender.seed!,
    mode: 'pull',
    network: NETWORK,
    slippageBps: 50,
    // Testnet's path indexer is slower than devnet -- give it more headroom
    // before declaring no path. Total budget: ~30s of retry sleep across
    // four attempts.
    pathFindRetryDelaysMs: [2_000, 4_000, 8_000, 16_000],
    onProgress: (e) => {
      if (e.type === 'paths_resolved') {
        resolved = {
          strategy: e.strategy,
          sourceAmountValue: e.sourceAmountValue,
          sourceAmountCurrency: e.sourceAmountCurrency,
        }
      }
    },
  })
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
      log.tx(receipt.reference, explorer(receipt.reference))
    }
  } else {
    log.error(`Failed: ${response.status} ${await response.text()}`)
  }

  // Realised-slippage report.
  const senderUsdAAfter = await readUsdBalance(xrpl, sender.classicAddress, issuerA.classicAddress)
  const recipientUsdBAfter = await readUsdBalance(
    xrpl,
    recipient.classicAddress,
    issuerB.classicAddress,
  )
  const debitedFromSender = (Number(senderUsdABefore) - Number(senderUsdAAfter)).toFixed(6)
  const deliveredToRecipient = (Number(recipientUsdBAfter) - Number(recipientUsdBBefore)).toFixed(6)
  const realizedSlippageBps = Math.round(
    ((Number(debitedFromSender) - Number(deliveredToRecipient)) /
      Math.max(Number(deliveredToRecipient), 1e-9)) *
      10_000,
  )

  log.separator()
  log.box([
    'Cross-issuer payment summary',
    '',
    `Path strategy:        ${resolved.strategy ?? 'n/a'}`,
    `Source debited:       ${debitedFromSender} USD.A`,
    `Destination delivered: ${deliveredToRecipient} USD.B`,
    `Pre-slippage source:  ${resolved.sourceAmountValue ?? 'n/a'} ${resolved.sourceAmountCurrency ?? ''}`,
    `Realised slippage:    ${realizedSlippageBps} bps (default cap 50 bps)`,
  ])

  await xrpl.disconnect()
  httpServer.close()
  log.separator()
  log.info('Cross-issuer IOU charge demo complete.')
  process.exit(0)
}

main().catch((err) => {
  log.error(`Fatal: ${err.message}`)
  process.exit(1)
})
