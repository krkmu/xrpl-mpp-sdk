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
import * as log from './log.js'

const rawFetch = globalThis.fetch

async function main() {
  log.box(['XRPL MPP Client -- PayChannel'])
  log.separator()

  log.loading('Connecting to XRPL testnet...')
  const xrplClient = new Client(XRPL_RPC_URLS.testnet)
  await xrplClient.connect()

  log.loading('Funding funder wallet via faucet...')
  const { wallet } = await xrplClient.fundWallet()
  await xrplClient.disconnect()

  log.wallet('Funder', wallet.classicAddress)
  log.key('Public key', wallet.publicKey)
  log.separator()

  // Get server address
  const infoRes = await rawFetch('http://localhost:3000/info')
  const { address: serverAddress } = (await infoRes.json()) as { address: string }
  log.wallet('Server', serverAddress)

  // Open channel
  log.loading('Opening PaymentChannel (10 XRP, 3600s settle delay)...')
  const { channelId, txHash: createHash } = await openChannel({
    seed: wallet.seed!,
    destination: serverAddress,
    amount: '10000000',
    settleDelay: 3600,
    network: 'testnet',
  })
  log.success(`Channel opened: ${channelId}`)
  log.tx(createHash, log.explorerLink(createHash))

  // Configure server
  await rawFetch('http://localhost:3000/setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channelId, publicKey: wallet.publicKey }),
  })
  log.success('Server configured')
  log.separator()

  // Patch fetch for auto 402 handling
  const channelMethod = channel({ seed: wallet.seed!, network: 'testnet' })
  Mppx.create({ methods: [channelMethod] })

  // Make 5 paid requests
  log.info('Making 5 paid requests (0.1 XRP each)...')
  log.separator()

  let lastCumulative = '0'
  for (let i = 1; i <= 5; i++) {
    const response = await fetch('http://localhost:3000/resource')
    if (response.ok) {
      const body = (await response.json()) as any
      lastCumulative = body.cumulative ?? lastCumulative
      log.success(
        `[${i}/5] cumulative: ${lastCumulative} drops (${(Number(lastCumulative) / 1_000_000).toFixed(1)} XRP)`,
      )
    } else {
      log.error(`[${i}/5] ${response.status}`)
    }
  }

  log.separator()

  // Close channel
  log.loading('Closing channel on-chain...')
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
  log.success('Channel closed')
  log.tx(closeHash, log.explorerLink(closeHash))

  // Tell server to shut down
  await rawFetch('http://localhost:3000/summary').catch(() => {})

  log.separator()
  log.box([
    'Summary',
    '',
    `Channel:         ${channelId}`,
    `Off-chain claims: 5`,
    `Total settled:   ${lastCumulative} drops (${(Number(lastCumulative) / 1_000_000).toFixed(1)} XRP)`,
    `On-chain txs:    2 (create + close)`,
  ])
  log.separator()

  process.exit(0)
}

main().catch((err) => {
  log.error(`Fatal: ${err.message}`)
  process.exit(1)
})
