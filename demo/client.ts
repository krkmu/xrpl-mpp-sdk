/**
 * Demo client -- pays for a resource via MPP 402 flow.
 *
 * Env vars:
 *   XRPL_SEED    (required) -- client wallet seed
 *   SERVER_URL   (optional) -- server URL, default http://localhost:3000
 *
 * Run:  XRPL_SEED=sEdXXX npx tsx demo/client.ts
 */

import { Receipt } from 'mppx'
import { Mppx } from 'mppx/client'
import { Wallet } from 'xrpl'
import { charge } from '../sdk/src/client/Charge.js'
import { XRPL_EXPLORER_URLS } from '../sdk/src/constants.js'

const SEED = process.env.XRPL_SEED
const SERVER_URL = process.env.SERVER_URL ?? 'http://localhost:3000'
const NETWORK = 'testnet'
const EXPLORER = XRPL_EXPLORER_URLS[NETWORK]

if (!SEED) {
  console.error('XRPL_SEED is required.')
  console.error('Run: npx tsx demo/setup-xrp.ts   to generate funded wallets.')
  process.exit(1)
}

const wallet = Wallet.fromSeed(SEED)
console.log(`[client] Wallet: ${wallet.classicAddress}`)
console.log(`[client] Server: ${SERVER_URL}`)
console.log(`[client] Network: ${NETWORK}\n`)

const chargeMethod = charge({
  seed: SEED,
  mode: 'pull',
  network: NETWORK,
  preflight: true,
  autoTrustline: true,
  autoMPTAuthorize: true,
})

Mppx.create({
  methods: [chargeMethod],
})

console.log(`[client] Requesting ${SERVER_URL}...\n`)

try {
  const response = await fetch(SERVER_URL)

  console.log(`[client] Response status: ${response.status}`)

  if (response.ok) {
    const body = await response.json()
    console.log(`[client] Body: ${JSON.stringify(body, null, 2)}`)

    const receiptHeader = response.headers.get('Payment-Receipt')
    if (receiptHeader) {
      const receipt = Receipt.deserialize(receiptHeader)
      console.log(`\n[client] Receipt:`)
      console.log(`  Method:    ${receipt.method}`)
      console.log(`  Status:    ${receipt.status}`)
      console.log(`  Reference: ${receipt.reference}`)
      console.log(`  Timestamp: ${receipt.timestamp}`)
      if (receipt.reference) {
        console.log(`\n[client] Explorer: ${EXPLORER}${receipt.reference}`)
      }
    }
  } else {
    console.error(`[client] Request failed with status ${response.status}`)
    const text = await response.text()
    if (text) console.error(`[client] Body: ${text}`)
  }
} catch (err: any) {
  console.error(`[client] Error: ${err.message}`)
}

console.log('\n[client] Done.')
