/**
 * Shared demo client for all charge demos.
 *
 * Usage:
 *   npx tsx demo/demo-client.ts [--seed sEdXXX] [--url http://localhost:3000/api/resource] [--mode pull]
 */
import { Mppx } from 'mppx/client'
import { charge } from '../sdk/src/client/Charge.js'
import { XRPL_EXPLORER_URLS } from '../sdk/src/constants.js'

const args = process.argv.slice(2)
function getArg(name: string, fallback: string): string {
  const idx = args.indexOf(`--${name}`)
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : fallback
}

const seed = getArg('seed', '')
const url = getArg('url', 'http://localhost:3000/api/resource')
const mode = getArg('mode', 'pull') as 'pull' | 'push'
const network = 'testnet'

if (!seed) {
  console.error('Error: --seed is required')
  console.error(
    'Usage: npx tsx demo/demo-client.ts --seed sEdXXX [--url http://...] [--mode pull|push]',
  )
  process.exit(1)
}

const chargeMethod = charge({
  seed,
  mode,
  network,
  preflight: true,
  autoTrustline: true,
  autoMPTAuthorize: true,
})

const mppx = Mppx.create({
  methods: [chargeMethod],
})

console.log(`[client] Requesting: ${url}`)
console.log(`[client] Mode: ${mode}`)
console.log(`[client] Network: ${network}`)

try {
  const response = await mppx.fetch(url)

  if (response.ok) {
    const body = await response.json()
    console.log('[client] Response:', JSON.stringify(body, null, 2))

    const receiptHeader = response.headers.get('Payment-Receipt')
    if (receiptHeader) {
      const { Receipt } = await import('mppx')
      const receipt = Receipt.deserialize(receiptHeader)
      console.log('[client] Receipt:', JSON.stringify(receipt, null, 2))

      if (receipt.reference) {
        console.log(`[client] Explorer: ${XRPL_EXPLORER_URLS[network]}${receipt.reference}`)
      }
    }
  } else {
    console.error(`[client] Failed with status ${response.status}`)
    const text = await response.text()
    console.error('[client] Body:', text)
  }
} catch (err: any) {
  console.error('[client] Error:', err.message)
}
