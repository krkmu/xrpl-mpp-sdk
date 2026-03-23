/**
 * DEMO: XRP Charge -- fully self-contained
 *
 * Generates wallets, funds them via testnet faucet, runs the full
 * MPP 402 charge flow (pull mode), and prints explorer links.
 *
 * Run: npx tsx demo/charge-xrp.ts
 */
import { Credential, Store } from 'mppx'
import { Client } from 'xrpl'
import { charge as clientCharge } from '../sdk/src/client/Charge.js'
import { XRPL_EXPLORER_URLS, XRPL_RPC_URLS } from '../sdk/src/constants.js'
import { charge as serverCharge } from '../sdk/src/server/Charge.js'

const NETWORK = 'testnet'
const AMOUNT = '1000000' // 1 XRP in drops
const EXPLORER = XRPL_EXPLORER_URLS[NETWORK]

async function main() {
  console.log('=== XRP Charge Demo (fully automated) ===\n')

  // -- 1. Connect to testnet and fund wallets --
  console.log('[1/5] Connecting to XRPL testnet...')
  const client = new Client(XRPL_RPC_URLS[NETWORK])
  await client.connect()

  console.log('[2/5] Funding wallets via faucet...')
  const { wallet: sender } = await client.fundWallet()
  const { wallet: receiver } = await client.fundWallet()
  console.log(`  Sender:   ${sender.classicAddress} (seed: ${sender.seed})`)
  console.log(`  Receiver: ${receiver.classicAddress}`)
  await client.disconnect()

  // -- 2. Create server method --
  const store = Store.memory()
  const serverMethod = serverCharge({
    recipient: receiver.classicAddress,
    network: NETWORK,
    store,
  })

  // -- 3. Create client method --
  const clientMethod = clientCharge({
    seed: sender.seed!,
    mode: 'pull',
    network: NETWORK,
  })

  // -- 4. Simulate MPP 402 flow --
  console.log(
    `\n[3/5] Server creates challenge: ${AMOUNT} drops of XRP to ${receiver.classicAddress}`,
  )
  const challenge = {
    id: `demo-${Date.now()}`,
    realm: 'demo.xrpl-mpp-sdk',
    method: 'xrpl' as const,
    intent: 'charge' as const,
    request: {
      amount: AMOUNT,
      currency: 'XRP',
      recipient: receiver.classicAddress,
      methodDetails: {
        network: NETWORK,
        reference: crypto.randomUUID(),
      },
    },
  }

  console.log('[4/5] Client creates credential (signing Payment tx)...')
  const credentialStr = await clientMethod.createCredential({ challenge })
  const credential = Credential.deserialize(credentialStr)
  console.log(`  Credential type: ${(credential.payload as any).type}`)
  console.log(`  Blob length: ${(credential.payload as any).blob?.length ?? 'N/A'} chars`)

  console.log('[5/5] Server verifies credential (submitting tx to ledger)...')
  const receipt = await serverMethod.verify({
    credential: credential as any,
    request: challenge.request,
  })

  // -- 5. Print results --
  console.log('\n=== RESULT ===')
  console.log(`  Status:    ${receipt.status}`)
  console.log(`  Method:    ${receipt.method}`)
  console.log(`  Reference: ${receipt.reference}`)
  console.log(`  Timestamp: ${receipt.timestamp}`)
  console.log(`\n  Explorer: ${EXPLORER}${receipt.reference}`)
  console.log('\n=== Demo complete ===')
}

main().catch((err) => {
  console.error('Demo failed:', err.message)
  process.exit(1)
})
