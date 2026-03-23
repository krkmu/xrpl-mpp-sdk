/**
 * Setup: fund two testnet wallets and print env vars for server + client.
 *
 * Run:  npx tsx demo/setup-xrp.ts
 * Then copy the printed env vars into two terminals.
 */
import { Client } from 'xrpl'
import { XRPL_RPC_URLS } from '../sdk/src/constants.js'

const client = new Client(XRPL_RPC_URLS.testnet)
await client.connect()

console.log('Funding 2 wallets on XRPL testnet...\n')
const { wallet: server } = await client.fundWallet()
const { wallet: payer } = await client.fundWallet()
await client.disconnect()

console.log('=== Copy-paste into Terminal 1 (server) ===\n')
console.log(`XRPL_RECIPIENT=${server.classicAddress} npx tsx demo/server.ts\n`)

console.log('=== Copy-paste into Terminal 2 (client) ===\n')
console.log(`XRPL_SEED=${payer.seed} npx tsx demo/client.ts\n`)

console.log(`Server address: ${server.classicAddress}`)
console.log(`Client address: ${payer.classicAddress}`)
