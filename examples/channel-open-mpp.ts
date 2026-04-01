/**
 * Channel Open via MPP 402 Flow
 *
 * Shows how a client can open a PayChannel through the standard
 * MPP challenge/credential flow instead of using a custom /setup endpoint.
 *
 * Flow overview:
 *   1. Client builds and signs a PaymentChannelCreate tx locally
 *   2. Client sends the signed tx blob as a credential with action: 'open'
 *   3. Server broadcasts the tx on-chain, extracts the channelId
 *   4. Server initializes cumulative tracking in its store
 *   5. Server returns a receipt containing the channelId
 *   6. Subsequent requests use action: 'voucher' (default) -- no custom
 *      /setup endpoint needed, everything goes through MPP 402
 *
 * This is a documentation example showing the client-side preparation.
 * It does not run the full two-process flow.
 *
 * Usage (illustrative -- prints the prepared tx blob):
 *   XRPL_SEED=sEdYourSeed npx tsx examples/channel-open-mpp.ts
 */
import { Mppx } from 'mppx/client'
import { Client, Wallet } from 'xrpl'
import { channel } from '../sdk/src/channel/client/Channel.js'

const SEED = process.env.XRPL_SEED
if (!SEED) {
  console.error('Usage: XRPL_SEED=sEdXxx npx tsx examples/channel-open-mpp.ts')
  process.exit(1)
}

const SERVER_DESTINATION = process.env.XRPL_DEST ?? 'rServerAddress...'

// -- Step 1: Prepare the PaymentChannelCreate tx locally --

const wallet = Wallet.fromSeed(SEED)
const xrplClient = new Client('wss://s.altnet.rippletest.net:51233')
await xrplClient.connect()

const channelCreate = {
  TransactionType: 'PaymentChannelCreate' as const,
  Account: wallet.classicAddress,
  Destination: SERVER_DESTINATION,
  Amount: '10000000', // 10 XRP in drops
  SettleDelay: 3600, // 1 hour settle delay
  PublicKey: wallet.publicKey,
}

const prepared = await xrplClient.autofill(channelCreate)
const signed = wallet.sign(prepared)
await xrplClient.disconnect()

console.log('Channel open via MPP flow -- client-side preparation')
console.log(`  Account:     ${wallet.classicAddress}`)
console.log(`  Destination: ${SERVER_DESTINATION}`)
console.log(`  Amount:      10 XRP (10000000 drops)`)
console.log(`  Tx blob:     ${signed.tx_blob.slice(0, 60)}...`)
console.log()

// -- Step 2: Configure Mppx with the channel method --
//
// The channel method supports action: 'open' in its context schema.
// When the client makes its first request, it passes the signed tx blob
// as openTransaction in the context.

const channelMethod = channel({ seed: SEED, network: 'testnet' })

Mppx.create({
  methods: [channelMethod],
})

// -- Step 3: First request -- open the channel through MPP 402 --
//
// In a real scenario the client would call:
//
//   const response = await fetch('https://api.example.com/resource', {
//     context: {
//       action: 'open',
//       openTransaction: signed.tx_blob,
//     },
//   })
//
// The MPP flow:
//   a) Client GETs the resource, receives 402 with WWW-Authenticate: Payment
//   b) Challenge contains method: 'xrpl', intent: 'channel'
//   c) Client's createCredential() sees action: 'open', includes the
//      signed PaymentChannelCreate blob in the credential payload
//   d) Server receives the credential, decodes the blob, verifies
//      Destination matches itself, broadcasts on-chain
//   e) Server extracts channelId from tx metadata, initializes store
//   f) Server returns 200 with Payment-Receipt containing the channelId
//
// -- Step 4: Subsequent requests -- voucher (default) --
//
// After the channel is open, all further requests use action: 'voucher'
// (the default). The client signs cumulative off-chain claims against
// the channelId returned in step 3.
//
//   const response = await fetch('https://api.example.com/resource')
//
// No custom /setup endpoint, no out-of-band coordination -- the entire
// channel lifecycle flows through the standard MPP 402 protocol.

console.log('This signed tx blob would be sent in the credential payload')
console.log('with action: "open". The server broadcasts it, extracts the')
console.log('channelId, and all subsequent requests use off-chain claims.')

process.exit(0)
