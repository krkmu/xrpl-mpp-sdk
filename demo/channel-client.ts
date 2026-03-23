/**
 * PayChannel -- Client
 * Generates a funder wallet, opens a channel, makes 5 paid requests, closes channel.
 * Run: npx tsx demo/channel-client.ts
 */

import { Mppx } from 'mppx/client'
import { Client, dropsToXrp, signPaymentChannelClaim } from 'xrpl'
import { channel, openChannel } from '../sdk/src/channel/client/Channel.js'
import { close } from '../sdk/src/channel/server/Channel.js'
import { XRPL_RPC_URLS } from '../sdk/src/constants.js'

const EXPLORER = 'https://testnet.xrpl.org/transactions/'

// Save raw fetch before mppx patches it
const rawFetch = globalThis.fetch

async function main() {
  // 1. Fund wallet
  const xrplClient = new Client(XRPL_RPC_URLS.testnet)
  await xrplClient.connect()
  const { wallet } = await xrplClient.fundWallet()
  await xrplClient.disconnect()
  console.log(`[client] Wallet: ${wallet.classicAddress}`)

  // 2. Get server address
  const infoRes = await rawFetch('http://localhost:3000/info')
  const { address: serverAddress } = (await infoRes.json()) as { address: string }
  console.log(`[client] Server: ${serverAddress}`)

  // 3. Open PaymentChannel -- 10 XRP, 3600s settle delay
  console.log('[client] Opening payment channel (10 XRP)...')
  const { channelId, txHash: createHash } = await openChannel({
    seed: wallet.seed!,
    destination: serverAddress,
    amount: '10000000',
    settleDelay: 3600,
    network: 'testnet',
  })
  console.log(`[client] Channel: ${channelId}`)
  console.log(`[client] Create tx: ${EXPLORER}${createHash}`)

  // 4. Tell server about the channel
  await rawFetch('http://localhost:3000/setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channelId, publicKey: wallet.publicKey }),
  })
  console.log('[client] Server configured')

  // 5. Set up mppx client (patches globalThis.fetch)
  const channelMethod = channel({ seed: wallet.seed!, network: 'testnet' })
  Mppx.create({ methods: [channelMethod] })

  // 6. Make 5 paid requests
  console.log('\n[client] Making 5 paid requests (0.1 XRP each)...')
  let lastCumulative = '0'
  for (let i = 1; i <= 5; i++) {
    const response = await fetch('http://localhost:3000/resource')
    if (response.ok) {
      const body = (await response.json()) as any
      lastCumulative = body.cumulative ?? lastCumulative
      console.log(`  [${i}/5] 200 OK -- cumulative: ${lastCumulative} drops`)
    } else {
      const text = await response.text()
      console.log(`  [${i}/5] ${response.status} -- ${text.slice(0, 100)}`)
    }
  }

  // 7. Close channel on-chain (client is the source, so it can close directly)
  console.log('\n[client] Closing channel on-chain...')
  const closeSig = signPaymentChannelClaim(
    channelId,
    dropsToXrp(lastCumulative).toString(),
    wallet.privateKey,
  )
  const { txHash: closeHash } = await close({
    seed: wallet.seed!,
    channelId,
    amount: lastCumulative,
    signature: closeSig,
    channelPublicKey: wallet.publicKey,
    network: 'testnet',
  })
  console.log(`[client] Close tx: ${EXPLORER}${closeHash}`)

  // 8. Tell server to print summary and shut down
  await rawFetch('http://localhost:3000/summary').catch(() => {})

  // 9. Summary
  console.log('\n=== Summary ===')
  console.log(`  Channel ID: ${channelId}`)
  console.log(`  Off-chain claims: 5`)
  console.log(
    `  Total settled: ${lastCumulative} drops (${(Number(lastCumulative) / 1_000_000).toFixed(1)} XRP)`,
  )
  console.log(`  On-chain txs: 2 (create + close)`)
  console.log(`  Create tx: ${EXPLORER}${createHash}`)
  console.log(`  Close tx:  ${EXPLORER}${closeHash}`)

  process.exit(0)
}

main().catch((err) => {
  console.error('[client] Fatal error:', err)
  process.exit(1)
})
