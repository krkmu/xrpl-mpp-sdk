/**
 * Shared demo server for all charge demos.
 *
 * Usage:
 *   npx tsx demo/demo-server.ts [--currency XRP|IOU|MPT] [--amount 1000000] [--port 3000]
 */
import { Mppx, Store } from 'mppx/server'
import { XRPL_EXPLORER_URLS } from '../sdk/src/constants.js'
import { charge } from '../sdk/src/server/Charge.js'

const args = process.argv.slice(2)
function getArg(name: string, fallback: string): string {
  const idx = args.indexOf(`--${name}`)
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : fallback
}

const port = Number(getArg('port', '3000'))
const currencyType = getArg('currency', 'XRP')
const amount = getArg('amount', '1000000')
const recipient = getArg('recipient', '')
const network = 'testnet'

if (!recipient) {
  console.error('Error: --recipient is required')
  console.error(
    'Usage: npx tsx demo/demo-server.ts --recipient rXXX [--currency XRP] [--amount 1000000]',
  )
  process.exit(1)
}

const store = Store.memory()

const chargeMethod = charge({
  recipient,
  network,
  store,
})

const mppx = Mppx.create({
  methods: [chargeMethod],
  realm: `localhost:${port}`,
})

const handler = mppx['xrpl/charge']({ amount, currency: currencyType })

const _server =
  Bun?.serve?.({
    port,
    async fetch(req: Request) {
      const url = new URL(req.url)
      if (url.pathname !== '/api/resource') {
        return new Response('Not found', { status: 404 })
      }

      const result = await handler(req)
      if (result.response) return result.response

      return result.withReceipt(
        new Response(
          JSON.stringify({
            message: 'Access granted! You paid for this resource.',
            timestamp: new Date().toISOString(),
          }),
          {
            headers: { 'Content-Type': 'application/json' },
          },
        ),
      )
    },
  }) ?? (await startNodeServer(handler, port))

console.log(`[server] Listening on http://localhost:${port}`)
console.log(`[server] Protected resource: http://localhost:${port}/api/resource`)
console.log(`[server] Expecting ${amount} drops of ${currencyType} to ${recipient}`)
console.log(`[server] Network: ${network}`)
console.log(`[server] Explorer: ${XRPL_EXPLORER_URLS[network]}`)

async function startNodeServer(handler: any, port: number) {
  // Fallback for Node.js (no Bun)
  const { createServer } = await import('node:http')

  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${port}`)
    if (url.pathname !== '/api/resource') {
      res.writeHead(404)
      res.end('Not found')
      return
    }

    // Convert node request to web Request
    const headers = new Headers()
    for (const [key, val] of Object.entries(req.headers)) {
      if (val) headers.set(key, Array.isArray(val) ? val[0] : val)
    }

    const webReq = new Request(`http://localhost:${port}${url.pathname}`, {
      method: req.method,
      headers,
    })

    try {
      const result = await handler(webReq)
      const response =
        result.response ??
        result.withReceipt(
          new Response(
            JSON.stringify({
              message: 'Access granted! You paid for this resource.',
              timestamp: new Date().toISOString(),
            }),
            {
              headers: { 'Content-Type': 'application/json' },
            },
          ),
        )

      res.writeHead(response.status, Object.fromEntries(response.headers.entries()))
      const body = await response.text()
      res.end(body)
    } catch (err: any) {
      res.writeHead(500)
      res.end(err.message)
    }
  })

  httpServer.listen(port)
  return httpServer
}
