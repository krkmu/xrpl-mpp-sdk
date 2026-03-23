/**
 * PayChannel -- Server
 * Generates a recipient wallet, waits for client to set up channel, serves 402-gated resource.
 * Run: npx tsx demo/channel-server.ts
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { Mppx, Store } from 'mppx/server'
import { Client } from 'xrpl'
import { channel } from '../sdk/src/channel/server/Channel.js'
import { XRPL_RPC_URLS } from '../sdk/src/constants.js'

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
    req.on('error', reject)
  })
}

function toWebRequest(req: IncomingMessage): Request {
  const host = req.headers.host ?? 'localhost:3000'
  const url = `http://${host}${req.url ?? '/'}`
  const headers = new Headers()
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue
    if (Array.isArray(value)) {
      for (const v of value) headers.append(key, v)
    } else {
      headers.set(key, value)
    }
  }
  return new Request(url, { method: req.method ?? 'GET', headers })
}

async function sendWebResponse(webRes: Response, res: ServerResponse): Promise<void> {
  res.statusCode = webRes.status
  for (const [key, value] of webRes.headers.entries()) {
    res.setHeader(key, value)
  }
  res.end(await webRes.text())
}

async function main() {
  const xrplClient = new Client(XRPL_RPC_URLS.testnet)
  await xrplClient.connect()
  const { wallet } = await xrplClient.fundWallet()
  await xrplClient.disconnect()

  console.log(`[server] Address: ${wallet.classicAddress}`)

  let channelId: string | null = null
  let handler: any = null
  let claimCount = 0
  let latestCumulative = '0'
  const store = Store.memory()

  const server = createServer(async (req, res) => {
    const path = req.url ?? '/'
    const method = req.method ?? 'GET'

    try {
      // GET /info -- return server address for client to open channel to
      if (method === 'GET' && path === '/info') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ address: wallet.classicAddress }))
        return
      }

      // POST /setup -- client sends channelId + publicKey after opening channel
      if (method === 'POST' && path === '/setup') {
        const body = JSON.parse(await readBody(req))
        channelId = body.channelId

        const channelMethod = channel({
          publicKey: body.publicKey,
          network: 'testnet',
          store,
        })

        const mppx = Mppx.create({
          secretKey: 'channel-demo-secret',
          methods: [channelMethod],
        })

        handler = (mppx as any)['xrpl/channel']({
          amount: '100000',
          channelId,
          recipient: wallet.classicAddress,
        })

        console.log(`[server] Channel configured: ${channelId}`)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ status: 'ok' }))
        return
      }

      // GET /resource -- 402/200 MPP channel flow
      if (method === 'GET' && path === '/resource') {
        if (!handler) {
          res.writeHead(503)
          res.end('Channel not configured yet')
          return
        }

        const webReq = toWebRequest(req)
        const result = await handler(webReq)

        if (result.status === 402) {
          console.log('[server] 402 /resource')
          await sendWebResponse(result.challenge as Response, res)
          return
        }

        claimCount++
        const state = (await store.get(`xrpl:channel:${channelId}`)) as any
        latestCumulative = state?.cumulative ?? latestCumulative

        console.log(
          `[server] 200 /resource -- claim #${claimCount}, cumulative: ${latestCumulative} drops`,
        )

        await sendWebResponse(
          result.withReceipt(
            Response.json({
              message: `Access granted -- claim #${claimCount}`,
              cumulative: latestCumulative,
            }),
          ) as Response,
          res,
        )
        return
      }

      // GET /summary -- return final state (called by client before closing)
      if (method === 'GET' && path === '/summary') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ claimCount, cumulative: latestCumulative }))

        // Shut down server after summary is fetched
        setTimeout(() => {
          console.log(
            `[server] Summary: ${claimCount} claims, ${(Number(latestCumulative) / 1_000_000).toFixed(1)} XRP total`,
          )
          server.close()
          process.exit(0)
        }, 500)
        return
      }

      res.writeHead(404)
      res.end('Not found')
    } catch (err: any) {
      console.error(`[server] Error: ${err.message}`)
      res.writeHead(500)
      res.end(err.message)
    }
  })

  server.listen(3000, () => {
    console.log('[server] Ready on http://localhost:3000 -- waiting for channel setup')
  })
}

main().catch((err) => {
  console.error('[server] Fatal error:', err)
  process.exit(1)
})
