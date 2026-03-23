/**
 * DEMO: PayChannel lifecycle -- fully self-contained
 *
 * Generates wallets, funds them, opens a channel, makes 5 off-chain
 * micropayments, then closes the channel. Prints explorer links.
 *
 * Run: npx tsx demo/channel-demo.ts
 */
import { Credential, Store } from 'mppx'
import { Client, dropsToXrp, verifyPaymentChannelClaim } from 'xrpl'
import { channel as clientChannel, openChannel } from '../sdk/src/channel/client/Channel.js'
import { close, channel as serverChannel } from '../sdk/src/channel/server/Channel.js'
import { XRPL_EXPLORER_URLS, XRPL_RPC_URLS } from '../sdk/src/constants.js'

const NETWORK = 'testnet'
const CHANNEL_AMOUNT = '10000000' // 10 XRP in drops
const PAYMENT_PER_REQUEST = '200000' // 0.2 XRP per request
const NUM_PAYMENTS = 5
const EXPLORER = XRPL_EXPLORER_URLS[NETWORK]

async function main() {
  console.log('=== PayChannel Demo (fully automated) ===\n')

  // -- 1. Connect and fund wallets --
  console.log('[1/7] Connecting to XRPL testnet...')
  const client = new Client(XRPL_RPC_URLS[NETWORK])
  await client.connect()

  console.log('[2/7] Funding wallets via faucet (sender + receiver)...')
  const { wallet: sender } = await client.fundWallet()
  const { wallet: receiver } = await client.fundWallet()
  console.log(`  Sender:   ${sender.classicAddress} (pubkey: ${sender.publicKey})`)
  console.log(`  Receiver: ${receiver.classicAddress}`)
  await client.disconnect()

  // -- 2. Open PayChannel --
  console.log('\n[3/7] Opening PayChannel (10 XRP, 60s settle delay)...')
  const { channelId, txHash: createTxHash } = await openChannel({
    seed: sender.seed!,
    destination: receiver.classicAddress,
    amount: CHANNEL_AMOUNT,
    settleDelay: 60,
    network: NETWORK,
  })
  console.log(`  Channel ID: ${channelId}`)
  console.log(`  Create tx:  ${EXPLORER}${createTxHash}`)

  // -- 3. Set up server and client methods --
  const store = Store.memory()
  const serverMethod = serverChannel({
    publicKey: sender.publicKey,
    network: NETWORK,
    store,
  })

  const clientMethod = clientChannel({
    seed: sender.seed!,
    network: NETWORK,
  })

  // -- 4. Make N off-chain micropayments --
  console.log(
    `\n[4/7] Making ${NUM_PAYMENTS} off-chain micropayments (${PAYMENT_PER_REQUEST} drops each)...`,
  )

  let lastReceipt: any = null
  for (let i = 1; i <= NUM_PAYMENTS; i++) {
    const _cumulativeAmount = (BigInt(PAYMENT_PER_REQUEST) * BigInt(i)).toString()
    const previousCumulative = (BigInt(PAYMENT_PER_REQUEST) * BigInt(i - 1)).toString()

    const challenge = {
      id: `demo-channel-${Date.now()}-${i}`,
      realm: 'demo.xrpl-mpp-sdk',
      method: 'xrpl' as const,
      intent: 'channel' as const,
      request: {
        amount: PAYMENT_PER_REQUEST,
        channelId,
        recipient: receiver.classicAddress,
        methodDetails: {
          network: NETWORK,
          reference: crypto.randomUUID(),
          cumulativeAmount: previousCumulative,
        },
      },
    }

    const credentialStr = await clientMethod.createCredential({ challenge })
    const credential = Credential.deserialize(credentialStr)

    const receipt = await serverMethod.verify({
      credential: credential as any,
      request: challenge.request,
    })

    const payload = credential.payload as any
    console.log(`  [${i}/${NUM_PAYMENTS}] cumulative: ${payload.amount} drops -- ${receipt.status}`)
    lastReceipt = { receipt, payload }
  }

  // -- 5. Verify the final claim signature independently --
  console.log('\n[5/7] Verifying final claim signature independently...')
  const finalPayload = lastReceipt.payload
  const isValid = verifyPaymentChannelClaim(
    channelId,
    dropsToXrp(finalPayload.amount),
    finalPayload.signature,
    sender.publicKey,
  )
  console.log(`  Signature valid: ${isValid}`)

  // -- 6. Close the channel --
  console.log('\n[6/7] Closing PayChannel on-chain...')
  const { txHash: closeTxHash } = await close({
    seed: sender.seed!,
    channelId,
    amount: finalPayload.amount,
    signature: finalPayload.signature,
    channelPublicKey: sender.publicKey,
    network: NETWORK,
  })
  console.log(`  Close tx: ${EXPLORER}${closeTxHash}`)

  // -- 7. Summary --
  console.log('\n[7/7] Summary')
  console.log(`  Channel ID:       ${channelId}`)
  console.log(`  Total payments:   ${NUM_PAYMENTS}`)
  console.log(
    `  Total amount:     ${finalPayload.amount} drops (${Number(finalPayload.amount) / 1_000_000} XRP)`,
  )
  console.log(`  On-chain txs:     2 (create + close)`)
  console.log(`  Off-chain claims: ${NUM_PAYMENTS}`)
  console.log(`\n  Create tx: ${EXPLORER}${createTxHash}`)
  console.log(`  Close tx:  ${EXPLORER}${closeTxHash}`)
  console.log('\n=== Demo complete ===')
}

main().catch((err) => {
  console.error('Demo failed:', err.message)
  process.exit(1)
})
