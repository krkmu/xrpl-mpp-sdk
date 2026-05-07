/**
 * One-command end-to-end demo.
 *
 *   pnpm agent-template
 *
 * Boots the Express server in this process, runs a single client call that
 * pays a 402 challenge end-to-end, prints the result + receipt, and exits.
 *
 * If RECIPIENT_SEED / PAYER_SEED are unset on testnet, ephemeral wallets
 * are auto-funded from the faucet.
 */
import { Mppx } from 'mppx/client'
import { fromDrops } from 'xrpl-mpp-sdk'
import { charge } from 'xrpl-mpp-sdk/client'
import { callAgent } from './client.js'
import { loadConfig, loadWallets } from './env.js'
import { type PaymentIntent, priceOf } from './intent.js'
import { createApp } from './server.js'

// Demo pricing: 1 XRP / 1k tokens. With model 'mock-large' (5x) and
// maxTokens 2000 in the intent below, the demo invoice ends up at
// exactly 10 XRP (10_000_000 drops). Override at runtime with the
// AGENT_PRICE_DROPS_PER_1K_TOKENS env var if you want something else.
if (!process.env.AGENT_PRICE_DROPS_PER_1K_TOKENS) {
  process.env.AGENT_PRICE_DROPS_PER_1K_TOKENS = '1000000'
}

async function main(): Promise<void> {
  const config = loadConfig()

  const intent: PaymentIntent = {
    prompt: 'Write a detailed analysis of the XRPL Machine Payments Protocol.',
    model: 'mock-large',
    maxTokens: 2000,
  }
  const quotedDrops = priceOf(intent, config.pricePer1kTokensDrops)

  banner('XRPL MPP -- AI Agent Template')
  console.log(`network:    ${config.network}`)
  console.log(`port:       ${config.port}`)
  console.log(
    `base price: ${config.pricePer1kTokensDrops} drops / 1k tokens` +
      `  (${fromDrops(config.pricePer1kTokensDrops.toString())} XRP)`,
  )
  console.log(`intent:     model=${intent.model}, maxTokens=${intent.maxTokens}`)
  console.log(`quoted:     ${quotedDrops} drops  (${fromDrops(quotedDrops.toString())} XRP)`)

  console.log('\n[1/4] funding wallets...')
  const { recipient, payer } = await loadWallets('both', config.network)
  if (!recipient || !payer) throw new Error('Failed to load wallets')
  console.log(`  recipient: ${recipient.address}`)
  console.log(`  payer:     ${payer.address}`)

  console.log('\n[2/4] booting Express agent server...')
  const app = createApp(config, recipient)
  const server = await new Promise<import('node:http').Server>((resolve) => {
    const s = app.listen(config.port, () => resolve(s))
  })
  console.log(`  listening on http://localhost:${config.port}`)

  // Smoke-test /info before we start patching fetch.
  const infoRes = await fetch(`http://localhost:${config.port}/info`)
  console.log(`  /info -> ${infoRes.status} ${await infoRes.text()}`)

  console.log('\n[3/4] configuring client (patches globalThis.fetch)...')
  Mppx.create({
    methods: [charge({ wallet: payer, mode: 'pull', network: config.network })],
  })

  console.log(
    `\n[4/4] sending payment intent to /agent/run (will pay ${fromDrops(quotedDrops.toString())} XRP)...`,
  )
  const t0 = Date.now()
  const result = await callAgent({
    serverUrl: `http://localhost:${config.port}`,
    intent,
  })
  const elapsed = Date.now() - t0

  banner('result')
  console.log(`status:  ${result.status} (took ${elapsed}ms end-to-end)`)
  console.log(`body:`)
  console.log(JSON.stringify(result.body, null, 2))

  if (result.receipt) {
    banner('receipt')
    console.log(`paid:      ${fromDrops(quotedDrops.toString())} XRP (${quotedDrops} drops)`)
    console.log(`method:    ${result.receipt.method}`)
    console.log(`reference: ${result.receipt.reference}`)
    console.log(`explorer:  ${result.receipt.explorerUrl}`)
  }

  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  )
  console.log('\n[done] server closed. exiting.')
  process.exit(result.ok ? 0 : 1)
}

function banner(text: string): void {
  const line = '-'.repeat(Math.max(40, text.length + 4))
  console.log(`\n${line}\n  ${text}\n${line}`)
}

main().catch((err) => {
  console.error('\n[agent-template] fatal:', err)
  process.exit(1)
})
