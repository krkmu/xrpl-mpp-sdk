/**
 * Demo server -- serves a payment-gated resource via MPP 402 flow.
 *
 * Env vars:
 *   XRPL_RECIPIENT  (required) -- server's XRPL address
 *   XRPL_CURRENCY   (optional) -- currency JSON, default "XRP"
 *   XRPL_AMOUNT     (optional) -- amount to charge, default "1000000" (1 XRP in drops)
 *   PORT            (optional) -- HTTP port, default 3000
 *
 * Run:  XRPL_RECIPIENT=rXXX npx tsx demo/server.ts
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { Mppx, Store } from 'mppx/server'
import { XRPL_EXPLORER_URLS } from '../sdk/src/constants.js'
import { charge } from '../sdk/src/server/Charge.js'
import type { XrplCurrency } from '../sdk/src/types.js'
import { parseCurrency } from '../sdk/src/utils/currency.js'

const PORT = Number(process.env.PORT ?? 3000)
const RECIPIENT = process.env.XRPL_RECIPIENT
const CURRENCY_STR = process.env.XRPL_CURRENCY ?? 'XRP'
const AMOUNT = process.env.XRPL_AMOUNT ?? '1000000'
const NETWORK = 'testnet'
const EXPLORER = XRPL_EXPLORER_URLS[NETWORK]

if (!RECIPIENT) {
  console.error('XRPL_RECIPIENT is required.')
  console.error('Run: npx tsx demo/setup-xrp.ts   to generate funded wallets.')
  process.exit(1)
}

let currency: XrplCurrency | undefined
if (CURRENCY_STR !== 'XRP') {
  currency = parseCurrency(CURRENCY_STR)
}

const store = Store.memory()
const chargeMethod = charge({ recipient: RECIPIENT, currency, network: NETWORK, store })

const mppx = Mppx.create({
  secretKey: process.env.MPP_SECRET_KEY ?? 'xrpl-mpp-demo-secret',
  methods: [chargeMethod],
})

// Node http <-> web Request/Response bridge
function toWebRequest(req: IncomingMessage): Request {
  const url = `http://${req.headers.host ?? `localhost:${PORT}`}${req.url}`
  const headers = new Headers()
  for (const [k, v] of Object.entries(req.headers)) {
    if (v) headers.set(k, Array.isArray(v) ? v.join(', ') : v)
  }
  return new Request(url, { method: req.method, headers })
}

async function sendWebResponse(webRes: Response, res: ServerResponse) {
  res.statusCode = webRes.status
  for (const [k, v] of webRes.headers.entries()) {
    res.setHeader(k, v)
  }
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Expose-Headers', 'WWW-Authenticate, Payment-Receipt')
  res.end(await webRes.text())
}

const handler = (mppx as any)['xrpl/charge']({ amount: AMOUNT, currency: CURRENCY_STR })

const server = createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(200, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    })
    return res.end()
  }

  const webReq = toWebRequest(req)

  try {
    const result = await handler(webReq)

    if (result.status === 402) {
      console.log(`[server] 402 challenge sent to client`)
      return sendWebResponse(result.challenge, res)
    }

    const receipt = result.receipt
    console.log(`[server] 200 -- payment verified`)
    if (receipt?.reference) {
      console.log(`[server] tx: ${EXPLORER}${receipt.reference}`)
    }

    return sendWebResponse(
      result.withReceipt(
        Response.json({
          message: 'Access granted -- you paid for this resource.',
          timestamp: new Date().toISOString(),
        }),
      ),
      res,
    )
  } catch (err: any) {
    console.error(`[server] Error: ${err.message}`)
    res.writeHead(500)
    res.end(JSON.stringify({ error: err.message }))
  }
})

server.listen(PORT, () => {
  console.log(`[server] Listening on http://localhost:${PORT}`)
  console.log(`[server] Recipient: ${RECIPIENT}`)
  console.log(`[server] Currency:  ${CURRENCY_STR}`)
  console.log(`[server] Amount:    ${AMOUNT}`)
  console.log(`[server] Network:   ${NETWORK}`)
  console.log(`[server] Explorer:  ${EXPLORER}`)
  console.log(`[server] Waiting for client...\n`)
})
