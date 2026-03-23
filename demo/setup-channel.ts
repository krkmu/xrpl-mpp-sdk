/**
 * Setup: fund wallets + open a PayChannel. Prints env vars for server + client.
 *
 * Run:  npx tsx demo/setup-channel.ts
 */
import { Client } from 'xrpl'
import { openChannel } from '../sdk/src/channel/client/Channel.js'
import { XRPL_EXPLORER_URLS, XRPL_RPC_URLS } from '../sdk/src/constants.js'

const EXPLORER = XRPL_EXPLORER_URLS.testnet

const client = new Client(XRPL_RPC_URLS.testnet)
await client.connect()

console.log('Funding 2 wallets on XRPL testnet (sender/client, receiver/server)...\n')
const { wallet: sender } = await client.fundWallet()
const { wallet: receiver } = await client.fundWallet()
await client.disconnect()

console.log('Opening PayChannel (10 XRP, 60s settle delay)...')
const { channelId, txHash } = await openChannel({
  seed: sender.seed!,
  destination: receiver.classicAddress,
  amount: '10000000', // 10 XRP in drops
  settleDelay: 60,
  network: 'testnet',
})
console.log(`  Channel ID: ${channelId}`)
console.log(`  Create tx:  ${EXPLORER}${txHash}\n`)

console.log('=== Copy-paste into Terminal 1 (server) ===\n')
console.log(
  `XRPL_CHANNEL_ID=${channelId} XRPL_CHANNEL_PUBKEY=${sender.publicKey} XRPL_RECIPIENT=${receiver.classicAddress} npx tsx demo/server-channel.ts\n`,
)

console.log('=== Copy-paste into Terminal 2 (client) ===\n')
console.log(
  `XRPL_SEED=${sender.seed} XRPL_CHANNEL_ID=${channelId} npx tsx demo/client-channel.ts\n`,
)

console.log(`Sender (channel source): ${sender.classicAddress}`)
console.log(`Receiver (server):       ${receiver.classicAddress}`)
console.log(`Channel ID:              ${channelId}`)
console.log(`Sender public key:       ${sender.publicKey}`)
