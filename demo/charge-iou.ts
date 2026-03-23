/**
 * DEMO: IOU Charge -- fully self-contained
 *
 * Generates 3 wallets (issuer, sender, receiver), funds them,
 * sets up DefaultRipple on issuer, creates trustlines, issues IOUs,
 * then runs the full MPP charge flow.
 *
 * Run: npx tsx demo/charge-iou.ts
 */
import { Credential, Store } from 'mppx'
import { Client } from 'xrpl'
import { charge as clientCharge } from '../sdk/src/client/Charge.js'
import { XRPL_EXPLORER_URLS, XRPL_RPC_URLS } from '../sdk/src/constants.js'
import { charge as serverCharge } from '../sdk/src/server/Charge.js'

const NETWORK = 'testnet'
const CURRENCY_CODE = 'USD'
const AMOUNT = '10' // 10 USD
const EXPLORER = XRPL_EXPLORER_URLS[NETWORK]

async function main() {
  console.log('=== IOU Charge Demo (fully automated) ===\n')

  // -- 1. Connect and fund 3 wallets --
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

  // -- 2. Enable DefaultRipple on issuer --
  console.log('\n[3/8] Enabling DefaultRipple on issuer...')
  const accountSet = {
    TransactionType: 'AccountSet' as const,
    Account: issuer.classicAddress,
    SetFlag: 8, // asfDefaultRipple
  }
  const asResult = await client.submitAndWait(accountSet, { wallet: issuer })
  const asMeta = asResult.result.meta as any
  console.log(`  AccountSet result: ${asMeta?.TransactionResult}`)

  // -- 3. Create trustlines --
  const limitAmount = {
    currency: CURRENCY_CODE,
    issuer: issuer.classicAddress,
    value: '1000000',
  }

  console.log('[4/8] Creating trustline: sender -> issuer...')
  const trustSender = {
    TransactionType: 'TrustSet' as const,
    Account: sender.classicAddress,
    LimitAmount: limitAmount,
  }
  const tsSender = await client.submitAndWait(trustSender, { wallet: sender })
  console.log(`  TrustSet result: ${(tsSender.result.meta as any)?.TransactionResult}`)

  console.log('[5/8] Creating trustline: receiver -> issuer...')
  const trustReceiver = {
    TransactionType: 'TrustSet' as const,
    Account: receiver.classicAddress,
    LimitAmount: limitAmount,
  }
  const tsReceiver = await client.submitAndWait(trustReceiver, { wallet: receiver })
  console.log(`  TrustSet result: ${(tsReceiver.result.meta as any)?.TransactionResult}`)

  // -- 4. Issue IOUs to sender --
  console.log('[6/8] Issuer sends 1000 USD to sender...')
  const issuePayment = {
    TransactionType: 'Payment' as const,
    Account: issuer.classicAddress,
    Destination: sender.classicAddress,
    Amount: {
      currency: CURRENCY_CODE,
      issuer: issuer.classicAddress,
      value: '1000',
    },
  }
  const ipResult = await client.submitAndWait(issuePayment, { wallet: issuer })
  console.log(`  Payment result: ${(ipResult.result.meta as any)?.TransactionResult}`)

  await client.disconnect()

  // -- 5. Run MPP charge flow --
  const currencyJson = JSON.stringify({ currency: CURRENCY_CODE, issuer: issuer.classicAddress })

  const store = Store.memory()
  const serverMethod = serverCharge({
    recipient: receiver.classicAddress,
    currency: { currency: CURRENCY_CODE, issuer: issuer.classicAddress },
    network: NETWORK,
    store,
  })

  const clientMethod = clientCharge({
    seed: sender.seed!,
    mode: 'pull',
    network: NETWORK,
  })

  console.log(`\n[7/8] Client creates credential (${AMOUNT} ${CURRENCY_CODE})...`)
  const challenge = {
    id: `demo-iou-${Date.now()}`,
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

  console.log('[8/8] Server verifies credential (submitting IOU payment)...')
  const receipt = await serverMethod.verify({
    credential: credential as any,
    request: challenge.request,
  })

  console.log('\n=== RESULT ===')
  console.log(`  Status:    ${receipt.status}`)
  console.log(`  Method:    ${receipt.method}`)
  console.log(`  Reference: ${receipt.reference}`)
  console.log(`  Currency:  ${CURRENCY_CODE} (issuer: ${issuer.classicAddress})`)
  console.log(`\n  Explorer: ${EXPLORER}${receipt.reference}`)
  console.log('\n=== Demo complete ===')
}

main().catch((err) => {
  console.error('Demo failed:', err.message)
  process.exit(1)
})
