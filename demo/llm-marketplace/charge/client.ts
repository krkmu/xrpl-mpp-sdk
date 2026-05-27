/**
 * LLM Marketplace -- Charge mode (native XRP) -- Client
 *
 * Fires ONE /complete request to the marketplace. mppx's patched fetch handles
 * the 402: signs a Payment tx, the server submits it to XRPL, validates, and
 * returns an SSE token stream. We parse the stream live and render tokens as
 * they arrive (no client-side sleep -- this is the real Anthropic cadence).
 *
 * Run: npx tsx demo/llm-marketplace/charge/client.ts
 *      (after `npx tsx demo/llm-marketplace/charge/server.ts`)
 */
import { Receipt } from 'mppx'
import { Mppx } from 'mppx/client'
import { charge } from '../../../sdk/src/client/Charge.js'
import { Wallet } from '../../../sdk/src/utils/wallet.js'
import * as log from '../../log.js'

const PORT = 3003
const BASE = `http://localhost:${PORT}`
const rawFetch = globalThis.fetch

// Edit the prompt + budget to taste. maxTokens is the worst-case the client
// is willing to pay for; the actual Anthropic generation will usually be less.
const PROMPT = 'Explain what the Machine Payments Protocol does in one short paragraph.'
const MAX_TOKENS = 120

type DoneEvent = {
  input_tokens: number
  output_tokens: number
  actual_cost: number
  paid: number
  overpayment: number
}

/** Parse text/event-stream chunks and yield { event, data } objects. */
async function* readSseEvents(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<{ event: string; data: any }> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    let sep = buffer.indexOf('\n\n')
    while (sep !== -1) {
      const raw = buffer.slice(0, sep)
      buffer = buffer.slice(sep + 2)
      sep = buffer.indexOf('\n\n')

      let event = 'message'
      let data = ''
      for (const line of raw.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim()
        else if (line.startsWith('data:')) data = line.slice(5).trim()
      }
      if (data) yield { event, data: JSON.parse(data) }
    }
  }
}

async function main() {
  log.box(['XRPL MPP -- LLM Marketplace (charge client, native XRP)'])
  log.separator()

  log.loading('Funding payer wallet via testnet faucet...')
  const wallet = await Wallet.fromFaucet({ network: 'testnet' })
  log.wallet('Payer', wallet.address)
  log.separator()

  log.loading(`Discovering marketplace at ${BASE}/info ...`)
  const info = (await (await rawFetch(`${BASE}/info`)).json()) as {
    address: string
    model: string
    pricing: { dropsPerInputToken: number; dropsPerOutputToken: number }
  }
  log.wallet('Marketplace', info.address)
  log.info(`Model: ${info.model}`)
  log.info(
    `Pricing: ${info.pricing.dropsPerInputToken} drops/in, ${info.pricing.dropsPerOutputToken} drops/out`,
  )
  log.separator()

  Mppx.create({ methods: [charge({ wallet, mode: 'pull', network: 'testnet' })] })

  log.info(`Prompt: "${PROMPT}"`)
  log.info(`maxTokens: ${MAX_TOKENS}`)
  log.loading('Sending POST /complete -- mppx will auto-handle the 402...')
  log.separator()

  const response = await fetch(`${BASE}/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: PROMPT, maxTokens: MAX_TOKENS }),
  })

  if (!response.ok) {
    log.error(`Request failed: ${response.status} ${await response.text()}`)
    process.exit(1)
  }

  if (!response.body) {
    log.error('No response body')
    process.exit(1)
  }

  log.success('Payment settled on-chain')
  try {
    const receipt = Receipt.fromResponse(response)
    log.tx(receipt.reference, log.explorerLink(receipt.reference))
  } catch {
    // No Payment-Receipt header -- still safe to continue, we just lose the link.
  }

  log.info('Streaming Anthropic tokens:')
  log.separator()
  process.stdout.write('   ')

  let done: DoneEvent | null = null
  for await (const evt of readSseEvents(response.body)) {
    if (evt.event === 'token') {
      process.stdout.write(evt.data.value)
    } else if (evt.event === 'done') {
      done = evt.data as DoneEvent
    } else if (evt.event === 'error') {
      process.stdout.write('\n')
      log.error(`Server stream error: ${evt.data.message}`)
      process.exit(1)
    }
  }
  process.stdout.write('\n')
  log.separator()

  if (!done) {
    log.error('Stream ended without a done event')
    process.exit(1)
  }

  log.box([
    'Settlement',
    '',
    `Anthropic usage:  ${done.input_tokens} input + ${done.output_tokens} output tokens`,
    `Real cost:        ${done.actual_cost} drops (${(done.actual_cost / 1_000_000).toFixed(6)} XRP)`,
    `Paid (quote):     ${done.paid} drops (worst case before generation)`,
    `Overpayment:      ${done.overpayment} drops (${((done.overpayment / done.paid) * 100).toFixed(1)}%)`,
    '',
    'Charge mode: 1 on-chain Payment tx settled the whole call.',
  ])

  process.exit(0)
}

main().catch((err) => {
  log.error(`Fatal: ${err.message}`)
  process.exit(1)
})
