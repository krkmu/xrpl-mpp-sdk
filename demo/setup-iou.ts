/**
 * Setup: create an IOU on testnet (issuer + DefaultRipple + trustlines + issuance).
 * Prints env vars for server + client.
 *
 * Run:  npx tsx demo/setup-iou.ts
 */
import { Client } from 'xrpl'
import { XRPL_RPC_URLS } from '../sdk/src/constants.js'

const CURRENCY = 'USD'

const client = new Client(XRPL_RPC_URLS.testnet)
await client.connect()

console.log('Funding 3 wallets on XRPL testnet (issuer, server, client)...\n')
const { wallet: issuer } = await client.fundWallet()
const { wallet: server } = await client.fundWallet()
const { wallet: payer } = await client.fundWallet()

// Enable DefaultRipple on issuer
console.log('Enabling DefaultRipple on issuer...')
const asResult = await client.submitAndWait(
  { TransactionType: 'AccountSet', Account: issuer.classicAddress, SetFlag: 8 },
  { wallet: issuer },
)
console.log(`  AccountSet: ${(asResult.result.meta as any)?.TransactionResult}`)

// Create trustlines
const limit = { currency: CURRENCY, issuer: issuer.classicAddress, value: '1000000' }

console.log('Creating trustline: server -> issuer...')
const ts1 = await client.submitAndWait(
  { TransactionType: 'TrustSet', Account: server.classicAddress, LimitAmount: limit },
  { wallet: server },
)
console.log(`  TrustSet: ${(ts1.result.meta as any)?.TransactionResult}`)

console.log('Creating trustline: client -> issuer...')
const ts2 = await client.submitAndWait(
  { TransactionType: 'TrustSet', Account: payer.classicAddress, LimitAmount: limit },
  { wallet: payer },
)
console.log(`  TrustSet: ${(ts2.result.meta as any)?.TransactionResult}`)

// Issue tokens to client
console.log('Issuing 10000 USD to client...')
const pay = await client.submitAndWait(
  {
    TransactionType: 'Payment',
    Account: issuer.classicAddress,
    Destination: payer.classicAddress,
    Amount: { currency: CURRENCY, issuer: issuer.classicAddress, value: '10000' },
  },
  { wallet: issuer },
)
console.log(`  Payment: ${(pay.result.meta as any)?.TransactionResult}`)

await client.disconnect()

const currencyJson = JSON.stringify({ currency: CURRENCY, issuer: issuer.classicAddress })

console.log('\n=== Copy-paste into Terminal 1 (server) ===\n')
console.log(
  `XRPL_RECIPIENT=${server.classicAddress} XRPL_CURRENCY='${currencyJson}' XRPL_AMOUNT=10 npx tsx demo/server.ts\n`,
)

console.log('=== Copy-paste into Terminal 2 (client) ===\n')
console.log(`XRPL_SEED=${payer.seed} npx tsx demo/client.ts\n`)

console.log(`Issuer:  ${issuer.classicAddress}`)
console.log(`Server:  ${server.classicAddress}`)
console.log(`Client:  ${payer.classicAddress}`)
console.log(`Currency: ${CURRENCY} (issuer: ${issuer.classicAddress})`)
