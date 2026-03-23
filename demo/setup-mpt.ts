/**
 * Setup: create an MPT on testnet (issuance + authorize holders + issue tokens).
 * Prints env vars for server + client.
 *
 * Run:  npx tsx demo/setup-mpt.ts
 */
import { Client } from 'xrpl'
import { XRPL_RPC_URLS } from '../sdk/src/constants.js'

const client = new Client(XRPL_RPC_URLS.testnet)
await client.connect()

console.log('Funding 3 wallets on XRPL testnet (issuer, server, client)...\n')
const { wallet: issuer } = await client.fundWallet()
const { wallet: server } = await client.fundWallet()
const { wallet: payer } = await client.fundWallet()

// Create MPT issuance
console.log('Creating MPTokenIssuance...')
const createResult = await client.submitAndWait(
  {
    TransactionType: 'MPTokenIssuanceCreate' as any,
    Account: issuer.classicAddress,
    AssetScale: 2,
    MaximumAmount: '100000000',
    Flags: 0x00000020, // tfMPTCanTransfer
  },
  { wallet: issuer },
)
console.log(`  MPTokenIssuanceCreate: ${(createResult.result.meta as any)?.TransactionResult}`)

// Get the issuance ID
const objects = await client.request({
  command: 'account_objects',
  account: issuer.classicAddress,
  type: 'mpt_issuance',
} as any)
const mptId = (objects.result as any).account_objects[0].mpt_issuance_id
console.log(`  MPTokenIssuanceID: ${mptId}`)

// Authorize holders
console.log('Authorizing server to hold MPT...')
const auth1 = await client.submitAndWait(
  {
    TransactionType: 'MPTokenAuthorize' as any,
    Account: server.classicAddress,
    MPTokenIssuanceID: mptId,
  },
  { wallet: server },
)
console.log(`  MPTokenAuthorize (server): ${(auth1.result.meta as any)?.TransactionResult}`)

console.log('Authorizing client to hold MPT...')
const auth2 = await client.submitAndWait(
  {
    TransactionType: 'MPTokenAuthorize' as any,
    Account: payer.classicAddress,
    MPTokenIssuanceID: mptId,
  },
  { wallet: payer },
)
console.log(`  MPTokenAuthorize (client): ${(auth2.result.meta as any)?.TransactionResult}`)

// Issue tokens to client
console.log('Issuing 10000 MPT to client...')
const pay = await client.submitAndWait(
  {
    TransactionType: 'Payment',
    Account: issuer.classicAddress,
    Destination: payer.classicAddress,
    Amount: { mpt_issuance_id: mptId, value: '10000' } as any,
  },
  { wallet: issuer },
)
console.log(`  Payment: ${(pay.result.meta as any)?.TransactionResult}`)

await client.disconnect()

const currencyJson = JSON.stringify({ mpt_issuance_id: mptId })

console.log('\n=== Copy-paste into Terminal 1 (server) ===\n')
console.log(
  `XRPL_RECIPIENT=${server.classicAddress} XRPL_CURRENCY='${currencyJson}' XRPL_AMOUNT=100 npx tsx demo/server.ts\n`,
)

console.log('=== Copy-paste into Terminal 2 (client) ===\n')
console.log(`XRPL_SEED=${payer.seed} npx tsx demo/client.ts\n`)

console.log(`Issuer:  ${issuer.classicAddress}`)
console.log(`Server:  ${server.classicAddress}`)
console.log(`Client:  ${payer.classicAddress}`)
console.log(`MPT ID:  ${mptId}`)
