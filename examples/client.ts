/**
 * Minimal XRPL MPP charge client.
 *
 * Usage:
 *   XRPL_SEED=sEdYourSeed npx tsx examples/client.ts
 *
 * Requires examples/server.ts running on localhost:3000.
 */
import { Receipt } from 'mppx'
import { Mppx } from 'mppx/client'
import { Wallet } from 'xrpl'
import { charge } from '../sdk/src/client/Charge.js'

const SEED = process.env.XRPL_SEED
if (!SEED) {
  console.error('Usage: XRPL_SEED=sEdYourSeed npx tsx examples/client.ts')
  process.exit(1)
}

const wallet = Wallet.fromSeed(SEED)
console.log(`Using XRPL account: ${wallet.classicAddress}`)

// Patches globalThis.fetch -- 402 responses handled automatically
Mppx.create({
  methods: [
    charge({
      seed: SEED,
      mode: 'pull',
      network: 'testnet',
    }),
  ],
})

const SERVER_URL = process.env.SERVER_URL ?? 'http://localhost:3000'

console.log(`\nRequesting ${SERVER_URL}...\n`)
const response = await fetch(SERVER_URL)
const data = await response.json()

console.log(`--- Response (${response.status}) ---`)
console.log(JSON.stringify(data, null, 2))

const receiptHeader = response.headers.get('Payment-Receipt')
if (receiptHeader) {
  const receipt = Receipt.deserialize(receiptHeader)
  console.log(`\n--- Receipt ---`)
  console.log(`Method:    ${receipt.method}`)
  console.log(`Reference: ${receipt.reference}`)
  console.log(`Explorer:  https://testnet.xrpl.org/transactions/${receipt.reference}`)
}

process.exit(0)
