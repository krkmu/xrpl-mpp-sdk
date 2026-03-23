/**
 * Demo channel server -- accepts off-chain PayChannel claims via MPP 402.
 *
 * Env vars:
 *   XRPL_CHANNEL_ID      (required) -- PayChannel ID
 *   XRPL_CHANNEL_PUBKEY  (required) -- channel source public key
 *   XRPL_RECIPIENT       (required) -- server address (channel destination)
 *   XRPL_AMOUNT          (optional) -- drops per request, default "200000"
 *   PORT                 (optional) -- HTTP port, default 3000
 *
 * Run:  XRPL_CHANNEL_ID=... XRPL_CHANNEL_PUBKEY=ED... XRPL_RECIPIENT=r... npx tsx demo/server-channel.ts
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { Mppx, Store } from 'mppx/server'
import { channel } from '../sdk/src/channel/server/Channel.js'

const PORT = Number(process.env.PORT ?? 3000)
const CHANNEL_ID = process.env.XRPL_CHANNEL_ID
const PUBKEY = process.env.XRPL_CHANNEL_PUBKEY
const RECIPIENT = process.env.XRPL_RECIPIENT
const AMOUNT = process.env.XRPL_AMOUNT ?? '200000'

if (!CHANNEL_ID || !PUBKEY || !RECIPIENT) {
  console.error('Required: XRPL_CHANNEL_ID, XRPL_CHANNEL_PUBKEY, XRPL_RECIPIENT')
  console.error('Run: npx tsx demo/setup-channel.ts   to set up a channel.')
  process.exit(1)
}

const store = Store.memory()
const channelMethod = channel({ publicKey: PUBKEY, network: 'testnet', store })

const mppx = Mppx.create({
  secretKey: process.env.MPP_SECRET_KEY ?? 'xrpl-mpp-demo-secret',
  methods: [channelMethod],
})

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

const handler = (mppx as any)['xrpl/channel']({
  amount: AMOUNT,
  channelId: CHANNEL_ID,
  recipient: RECIPIENT,
})

let requestCount = 0
const server = createServer(async (req, res) => {
  const webReq = toWebRequest(req)

  try {
    const result = await handler(webReq)
    if (result.status === 402) {
      console.log(`[server] 402 challenge sent`)
      return sendWebResponse(result.challenge, res)
    }

    requestCount++
    console.log(`[server] 200 -- claim #${requestCount} verified`)

    return sendWebResponse(
      result.withReceipt(
        Response.json({
          message: `Access granted (request #${requestCount})`,
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
  console.log(`[server] Channel server on http://localhost:${PORT}`)
  console.log(`[server] Channel:  ${CHANNEL_ID}`)
  console.log(`[server] PubKey:   ${PUBKEY}`)
  console.log(`[server] Per-req:  ${AMOUNT} drops`)
  console.log(`[server] Waiting for client...\n`)
})
