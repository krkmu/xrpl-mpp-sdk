/**
 * DEMO: MPT Charge -- fully self-contained
 *
 * Generates wallets, funds them, creates an MPT issuance,
 * authorizes holders, issues MPTs, then runs the full MPP charge flow.
 *
 * Run: npx tsx demo/charge-mpt.ts
 */
import { Credential, Store } from 'mppx'
import { Client } from 'xrpl'
import { charge as clientCharge } from '../sdk/src/client/Charge.js'
import { XRPL_EXPLORER_URLS, XRPL_RPC_URLS } from '../sdk/src/constants.js'
import { charge as serverCharge } from '../sdk/src/server/Charge.js'

const NETWORK = 'testnet'
const AMOUNT = '100'
const EXPLORER = XRPL_EXPLORER_URLS[NETWORK]

async function main() {
  console.log('=== MPT Charge Demo (fully automated) ===\n')

  // -- 1. Connect and fund wallets --
  console.log('[1/8] Connecting to XRPL testnet...')
  const client = new Client(XRPL_RPC_URLS[NETWORK])
  await client.connect()

  console.log('[2/8] Funding 3 wallets via faucet (issuer, sender, receiver)...')
  const { wallet: issuer } = await client.fundWallet()
  const { wallet: sender } = await client.fundWallet()
  const { wallet: receiver } = await client.fundWallet()
  console.log(`  Issuer:   ${issuer.classicAddress}`)
  console.log(`  Sender:   ${sender.classicAddress}`)
  console.log(`  Receiver: ${receiver.classicAddress}`)

  // -- 2. Create MPT Issuance --
  console.log('\n[3/8] Creating MPTokenIssuance...')
  const mptIssuanceCreate = {
    TransactionType: 'MPTokenIssuanceCreate' as const,
    Account: issuer.classicAddress,
    AssetScale: 2,
    MaximumAmount: '100000000',
    Flags: 0x00000020, // tfMPTCanTransfer -- allow peer-to-peer transfers
  }
  const createResult = await client.submitAndWait(mptIssuanceCreate, { wallet: issuer })
  const createMeta = createResult.result.meta as any
  console.log(`  MPTokenIssuanceCreate result: ${createMeta?.TransactionResult}`)

  // Extract MPTokenIssuanceID from account_objects
  const mptIssuanceId = await getMPTIssuanceId(client, issuer.classicAddress)
  console.log(`  MPTokenIssuanceID: ${mptIssuanceId}`)

  // -- 3. Authorize sender to hold MPT --
  console.log('[4/8] Sender authorizes MPT holding...')
  const authSender = {
    TransactionType: 'MPTokenAuthorize' as const,
    Account: sender.classicAddress,
    MPTokenIssuanceID: mptIssuanceId,
  }
  const authSResult = await client.submitAndWait(authSender, { wallet: sender })
  console.log(
    `  MPTokenAuthorize (sender) result: ${(authSResult.result.meta as any)?.TransactionResult}`,
  )

  // -- 4. Authorize receiver to hold MPT --
  console.log('[5/8] Receiver authorizes MPT holding...')
  const authReceiver = {
    TransactionType: 'MPTokenAuthorize' as const,
    Account: receiver.classicAddress,
    MPTokenIssuanceID: mptIssuanceId,
  }
  const authRResult = await client.submitAndWait(authReceiver, { wallet: receiver })
  console.log(
    `  MPTokenAuthorize (receiver) result: ${(authRResult.result.meta as any)?.TransactionResult}`,
  )

  // -- 5. Issue MPTs to sender --
  console.log('[6/8] Issuer sends 10000 MPT to sender...')
  const mptPayment = {
    TransactionType: 'Payment' as const,
    Account: issuer.classicAddress,
    Destination: sender.classicAddress,
    Amount: {
      mpt_issuance_id: mptIssuanceId,
      value: '10000',
    },
  }
  const mpResult = await client.submitAndWait(mptPayment, { wallet: issuer })
  console.log(`  MPT Payment result: ${(mpResult.result.meta as any)?.TransactionResult}`)

  await client.disconnect()

  // -- 6. Run MPP charge flow --
  const currencyJson = JSON.stringify({ mpt_issuance_id: mptIssuanceId })

  const store = Store.memory()
  const serverMethod = serverCharge({
    recipient: receiver.classicAddress,
    currency: { mpt_issuance_id: mptIssuanceId },
    network: NETWORK,
    store,
  })

  const clientMethod = clientCharge({
    seed: sender.seed!,
    mode: 'pull',
    network: NETWORK,
  })

  console.log(`\n[7/8] Client creates credential (${AMOUNT} MPT)...`)
  const challenge = {
    id: `demo-mpt-${Date.now()}`,
    realm: 'demo.xrpl-mpp-sdk',
    method: 'xrpl' as const,
    intent: 'charge' as const,
    request: {
      amount: AMOUNT,
      currency: currencyJson,
      recipient: receiver.classicAddress,
      methodDetails: {
        network: NETWORK,
        reference: crypto.randomUUID(),
      },
    },
  }

  const credentialStr = await clientMethod.createCredential({ challenge })
  const credential = Credential.deserialize(credentialStr)
  console.log(`  Credential type: ${(credential.payload as any).type}`)

  console.log('[8/8] Server verifies credential (submitting MPT payment)...')
  const receipt = await serverMethod.verify({
    credential: credential as any,
    request: challenge.request,
  })

  console.log('\n=== RESULT ===')
  console.log(`  Status:    ${receipt.status}`)
  console.log(`  Method:    ${receipt.method}`)
  console.log(`  Reference: ${receipt.reference}`)
  console.log(`  MPT ID:    ${mptIssuanceId}`)
  console.log(`\n  Explorer: ${EXPLORER}${receipt.reference}`)
  console.log('\n=== Demo complete ===')
}

async function getMPTIssuanceId(client: Client, issuerAddress: string): Promise<string> {
  const response = await client.request({
    command: 'account_objects',
    account: issuerAddress,
    type: 'mpt_issuance',
  } as any)
  const objects = (response.result as any).account_objects
  if (!objects || objects.length === 0) {
    throw new Error('No MPTokenIssuance objects found for issuer')
  }
  // Return the mpt_issuance_id field from the first issuance
  const issuance = objects[0]
  return issuance.mpt_issuance_id
}

main().catch((err) => {
  console.error('Demo failed:', err.message)
  process.exit(1)
})
