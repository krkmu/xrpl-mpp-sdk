/**
 * TS client -- builds a payment intent and calls the agent server.
 *
 * The mppx client patches globalThis.fetch, so the 402 challenge from the
 * server is paid for and retried automatically. We just `fetch()` like usual.
 */
import { Receipt } from 'mppx'
import { Mppx } from 'mppx/client'
import { charge } from 'xrpl-mpp-sdk/client'
import { loadConfig, loadWallets } from './env.js'
import type { PaymentIntent } from './intent.js'

export type CallAgentArgs = {
  serverUrl: string
  intent: PaymentIntent
  /** When provided, used as-is. Otherwise the patched fetch is used. */
  fetchImpl?: typeof fetch
}

export type CallAgentResult = {
  ok: boolean
  status: number
  body: unknown
  receipt?: {
    method: string
    reference: string
    explorerUrl: string
  }
}

/** Make one paid call to /agent/run and return the parsed result + receipt. */
export async function callAgent(args: CallAgentArgs): Promise<CallAgentResult> {
  const doFetch = args.fetchImpl ?? fetch
  const response = await doFetch(`${args.serverUrl}/agent/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(args.intent),
  })

  const text = await response.text()
  const body = safeJson(text)

  if (!response.ok) {
    return { ok: false, status: response.status, body }
  }

  const receiptHeader = response.headers.get('Payment-Receipt')
  if (!receiptHeader) {
    return { ok: true, status: response.status, body }
  }

  const receipt = Receipt.deserialize(receiptHeader)
  return {
    ok: true,
    status: response.status,
    body,
    receipt: {
      method: receipt.method,
      reference: receipt.reference,
      explorerUrl: explorerUrl(receipt.reference),
    },
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function explorerUrl(txHash: string, network = 'testnet'): string {
  const host =
    network === 'mainnet'
      ? 'https://livenet.xrpl.org'
      : network === 'devnet'
        ? 'https://devnet.xrpl.org'
        : 'https://testnet.xrpl.org'
  return `${host}/transactions/${txHash}`
}

// ---------------------------------------------------------------------------
// CLI entry: `tsx src/client.ts`
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const config = loadConfig()
  const { payer } = await loadWallets('payer', config.network)
  if (!payer) throw new Error('Failed to load payer wallet')

  console.log(`[agent-template] payer:    ${payer.address}`)
  console.log(`[agent-template] server:   ${config.serverUrl}`)
  console.log(`[agent-template] network:  ${config.network}`)

  // Patches globalThis.fetch -- 402s are now handled automatically.
  Mppx.create({
    methods: [charge({ wallet: payer, mode: 'pull', network: config.network })],
  })

  const intent: PaymentIntent = {
    prompt:
      process.argv.slice(2).join(' ').trim() ||
      'Write a one-sentence summary of the XRPL Machine Payments Protocol.',
    model: 'mock-small',
    maxTokens: 64,
  }

  console.log(`\n[agent-template] sending intent: ${JSON.stringify(intent)}`)
  console.log('[agent-template] (fetch will pay any 402 challenge automatically)\n')

  const result = await callAgent({ serverUrl: config.serverUrl, intent })

  console.log(`--- response (${result.status}) ---`)
  console.log(JSON.stringify(result.body, null, 2))

  if (result.receipt) {
    console.log('\n--- receipt ---')
    console.log(`method:    ${result.receipt.method}`)
    console.log(`reference: ${result.receipt.reference}`)
    console.log(`explorer:  ${result.receipt.explorerUrl}`)
  }

  process.exit(result.ok ? 0 : 1)
}

const isMain = import.meta.url === `file://${process.argv[1]}`
if (isMain) {
  main().catch((err) => {
    console.error('[agent-template] fatal:', err)
    process.exit(1)
  })
}
