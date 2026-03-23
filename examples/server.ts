/**
 * Minimal XRPL MPP charge server.
 *
 * Usage:
 *   XRPL_RECIPIENT=rYourAddress npx tsx examples/server.ts
 *
 * Then test with:
 *   XRPL_SEED=sEdYourSeed npx tsx examples/client.ts
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { Mppx, Store } from 'mppx/server'
import { charge } from '../sdk/src/server/Charge.js'

const PORT = Number(process.env.PORT ?? 3000)
const RECIPIENT = process.env.XRPL_RECIPIENT

if (!RECIPIENT) {
  console.error('Usage: XRPL_RECIPIENT=rYourAddress npx tsx examples/server.ts')
  process.exit(1)
}

const mppx = Mppx.create({
  secretKey: process.env.MPP_SECRET_KEY ?? 'dev-secret-change-me',
  methods: [
    charge({
      recipient: RECIPIENT,
      network: 'testnet',
      store: Store.memory(),
    }),
  ],
})

// -- Node http <-> Web Request/Response bridge --

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
  for (const [k, v] of webRes.headers.entries()) res.setHeader(k, v)
  res.end(await webRes.text())
}

// -- Handler --

const handler = (mppx as any)['xrpl/charge']({
  amount: '1000000', // 1 XRP
  currency: 'XRP',
  description: 'API access',
})

const server = createServer(async (req, res) => {
  const result = await handler(toWebRequest(req))

  if (result.status === 402) {
    return sendWebResponse(result.challenge, res)
  }

  return sendWebResponse(
    result.withReceipt(
      Response.json({
        message: 'Payment verified -- here is your content.',
        timestamp: new Date().toISOString(),
      }),
    ),
    res,
  )
})

server.listen(PORT, () => {
  console.log(`XRPL MPP server on http://localhost:${PORT}`)
  console.log(`Recipient: ${RECIPIENT}`)
})
