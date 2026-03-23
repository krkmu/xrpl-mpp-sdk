/**
 * XRP Charge -- Server
 * Generates a recipient wallet, starts HTTP server, serves a 402-gated resource.
 * Run: npx tsx demo/xrp-server.ts
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { Mppx, Store } from 'mppx/server'
import { Client } from 'xrpl'
import { XRPL_RPC_URLS } from '../sdk/src/constants.js'
import { charge } from '../sdk/src/server/Charge.js'

async function main() {
  // 1. Connect to XRPL testnet and fund a recipient wallet
  const xrplClient = new Client(XRPL_RPC_URLS.testnet)
  await xrplClient.connect()
  const { wallet } = await xrplClient.fundWallet()
  await xrplClient.disconnect()

  console.log(`[server] Recipient: ${wallet.classicAddress}`)

  // 2. Create store for replay protection
  const store = Store.memory()

  // 3. Create the XRPL charge method for the server
  const chargeMethod = charge({
    recipient: wallet.classicAddress,
    network: 'testnet',
    store,
  })

  // 4. Create the mppx server instance
  const mppx = Mppx.create({
    secretKey: 'xrpl-mpp-demo-secret',
    methods: [chargeMethod],
  })

  // 5. Create the handler for XRP charge -- 1,000,000 drops = 1 XRP
  const handler = (mppx as any)['xrpl/charge']({ amount: '1000000', currency: 'XRP' })

  // 6. Bridge helpers: Node HTTP <-> Web Request/Response

  function toWebRequest(req: IncomingMessage): Request {
    const host = req.headers.host ?? 'localhost:3000'
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

  // 7. Create and start the HTTP server
  const server = createServer(async (req, res) => {
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
        message: 'Access granted -- paid 1 XRP',
        timestamp: new Date().toISOString(),
      })
      const finalResponse = result.withReceipt(payload) as Response
      await sendWebResponse(finalResponse, res)
      return
    }

    res.statusCode = 404
    res.end('Not found')
    console.log(`[server] 404 ${path}`)
  })

  server.listen(3000, () => {
    console.log('[server] Ready on http://localhost:3000 -- pay 1 XRP to access /resource')
  })
}

main().catch((err) => {
  console.error('[server] Fatal error:', err)
  process.exit(1)
})
