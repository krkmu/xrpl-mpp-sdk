/**
 * Demo channel client -- pays for resources via off-chain PayChannel claims.
 *
 * Env vars:
 *   XRPL_SEED        (required) -- sender wallet seed (channel source)
 *   XRPL_CHANNEL_ID  (required) -- PayChannel ID
 *   SERVER_URL       (optional) -- server URL, default http://localhost:3000
 *   NUM_REQUESTS     (optional) -- number of paid requests, default 5
 *
 * Run:  XRPL_SEED=sEdXXX XRPL_CHANNEL_ID=... npx tsx demo/client-channel.ts
 */

import { Receipt } from 'mppx'
import { Mppx } from 'mppx/client'
import { Wallet } from 'xrpl'
import { channel } from '../sdk/src/channel/client/Channel.js'

const SEED = process.env.XRPL_SEED
const CHANNEL_ID = process.env.XRPL_CHANNEL_ID
const SERVER_URL = process.env.SERVER_URL ?? 'http://localhost:3000'
const NUM_REQUESTS = Number(process.env.NUM_REQUESTS ?? 5)

if (!SEED || !CHANNEL_ID) {
  console.error('Required: XRPL_SEED, XRPL_CHANNEL_ID')
  console.error('Run: npx tsx demo/setup-channel.ts   to set up a channel.')
  process.exit(1)
}

const wallet = Wallet.fromSeed(SEED)
console.log(`[client] Wallet:  ${wallet.classicAddress}`)
console.log(`[client] Channel: ${CHANNEL_ID}`)
console.log(`[client] Server:  ${SERVER_URL}`)
console.log(`[client] Requests: ${NUM_REQUESTS}\n`)

const channelMethod = channel({ seed: SEED, network: 'testnet' })

Mppx.create({
  methods: [channelMethod],
})

for (let i = 1; i <= NUM_REQUESTS; i++) {
  console.log(`[client] Request ${i}/${NUM_REQUESTS}...`)

  try {
    const response = await fetch(SERVER_URL)

    if (response.ok) {
      const body = await response.json()
      const receiptHeader = response.headers.get('Payment-Receipt')
      if (receiptHeader) {
        const receipt = Receipt.deserialize(receiptHeader)
        console.log(`  -> ${receipt.status} (ref: ${receipt.reference})`)
      } else {
        console.log(`  -> ${response.status} ${JSON.stringify(body)}`)
      }
    } else {
      console.error(`  -> Failed: ${response.status}`)
    }
  } catch (err: any) {
    console.error(`  -> Error: ${err.message}`)
  }
}

console.log('\n[client] Done.')
