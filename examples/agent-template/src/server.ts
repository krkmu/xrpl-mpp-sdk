/**
 * Express server -- holds the recipient wallet, exposes MPP-gated endpoints.
 *
 * The wallet is loaded from RECIPIENT_SEED (or auto-funded on testnet).
 * See src/env.ts for the production warning -- do NOT keep raw seeds in
 * .env in production.
 */
import type { IncomingHttpHeaders } from 'node:http'
import express, { type Express, type Request, type Response } from 'express'
import { Mppx, Store } from 'mppx/server'
import type { Wallet } from 'xrpl-mpp-sdk'
import { charge } from 'xrpl-mpp-sdk/server'
import { runAgent } from './agent.js'
import { type Config, loadConfig, loadWallets } from './env.js'
import { PaymentIntent, priceOf } from './intent.js'

/** Build the Express app with MPP charge wired up. */
export function createApp(config: Config, recipient: Wallet): Express {
  const mppx = Mppx.create({
    secretKey: config.mppSecretKey,
    methods: [
      charge({
        recipient: recipient.address,
        network: config.network,
        store: Store.memory(),
      }),
    ],
  })

  const app = express()
  app.use(express.json({ limit: '64kb' }))

  app.get('/info', (_req, res) => {
    res.json({
      recipient: recipient.address,
      network: config.network,
      pricing: {
        basePricePer1kTokensDrops: config.pricePer1kTokensDrops.toString(),
        currency: 'XRP',
        note: 'Final price depends on `model` and `maxTokens` in the intent.',
      },
      endpoints: {
        run: 'POST /agent/run',
        info: 'GET /info',
      },
    })
  })

  app.post('/agent/run', async (req: Request, res: Response) => {
    const parsed = PaymentIntent.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({
        error: 'INVALID_INTENT',
        issues: parsed.error.issues,
      })
      return
    }
    const intent = parsed.data
    const amountDrops = priceOf(intent, config.pricePer1kTokensDrops)

    const handler = mppx['xrpl/charge']({
      amount: amountDrops.toString(),
      currency: 'XRP',
      description: `agent.run model=${intent.model} maxTokens=${intent.maxTokens}`,
    })

    const result = await handler(toWebRequest(req))

    if (result.status === 402) {
      await sendWebResponse(result.challenge, res)
      return
    }

    const agentResult = await runAgent(intent)

    const webRes = result.withReceipt(
      Response.json({
        ok: true,
        intent,
        result: agentResult,
        paid: { amountDrops: amountDrops.toString(), currency: 'XRP' },
      }),
    )
    await sendWebResponse(webRes, res)
  })

  app.use((_req, res) => {
    res.status(404).json({ error: 'NOT_FOUND' })
  })

  return app
}

/**
 * Boot the server. Used both as a CLI entry point (when run directly with
 * tsx) and from run-demo.ts.
 */
export async function startServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const config = loadConfig()
  const { recipient } = await loadWallets('recipient', config.network)
  if (!recipient) throw new Error('Failed to load recipient wallet')

  const app = createApp(config, recipient)
  const url = `http://localhost:${config.port}`

  return await new Promise((resolve) => {
    const server = app.listen(config.port, () => {
      console.log(`[agent-template] server listening on ${url}`)
      console.log(`[agent-template] recipient: ${recipient.address}`)
      console.log(`[agent-template] network:   ${config.network}`)
      resolve({
        url,
        close: () => new Promise<void>((r, j) => server.close((err) => (err ? j(err) : r()))),
      })
    })
  })
}

// ---------------------------------------------------------------------------
// Express <-> Web Request/Response bridge
// ---------------------------------------------------------------------------

function toWebRequest(req: Request): globalThis.Request {
  const host = req.headers.host ?? `localhost`
  const url = `${req.protocol}://${host}${req.originalUrl}`
  const headers = new Headers()
  copyHeaders(req.headers, headers)

  const init: RequestInit = { method: req.method, headers }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    // Express has already parsed JSON; serialize it back so mppx sees the
    // exact body bytes the client sent. For other content types you'd want
    // to use a raw-body parser instead.
    init.body = JSON.stringify(req.body ?? {})
    if (!headers.has('content-type')) {
      headers.set('content-type', 'application/json')
    }
  }
  return new Request(url, init)
}

function copyHeaders(src: IncomingHttpHeaders, dst: Headers): void {
  for (const [k, v] of Object.entries(src)) {
    if (v === undefined) continue
    if (Array.isArray(v)) {
      for (const val of v) dst.append(k, val)
    } else {
      dst.set(k, v)
    }
  }
}

async function sendWebResponse(webRes: globalThis.Response, res: Response): Promise<void> {
  res.status(webRes.status)
  webRes.headers.forEach((v, k) => {
    res.setHeader(k, v)
  })
  res.send(await webRes.text())
}

// Allow `tsx src/server.ts` directly.
const isMain = import.meta.url === `file://${process.argv[1]}`
if (isMain) {
  startServer().catch((err) => {
    console.error('[agent-template] fatal:', err)
    process.exit(1)
  })
}
