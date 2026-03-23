/**
 * XRP Charge -- Client
 * Generates a payer wallet, sends a paid request to the server.
 * Run: npx tsx demo/xrp-client.ts
 */
import { Receipt } from 'mppx'
import { Mppx } from 'mppx/client'
import { Client } from 'xrpl'
import { charge } from '../sdk/src/client/Charge.js'
import { XRPL_RPC_URLS } from '../sdk/src/constants.js'
import * as log from './log.js'

async function main() {
  log.box(['XRPL MPP Client -- XRP Charge'])
  log.separator()

  log.loading('Connecting to XRPL testnet...')
  const xrplClient = new Client(XRPL_RPC_URLS.testnet)
  await xrplClient.connect()

  log.loading('Funding payer wallet via faucet...')
  const { wallet } = await xrplClient.fundWallet()
  await xrplClient.disconnect()

  log.wallet('Payer', wallet.classicAddress)
  log.separator()

  const chargeMethod = charge({
    seed: wallet.seed!,
    mode: 'pull',
    network: 'testnet',
  })

  Mppx.create({ methods: [chargeMethod] })

  log.loading('Requesting http://localhost:3000/resource...')
  const response = await fetch('http://localhost:3000/resource')

  log.info(`Response status: ${response.status}`)

  if (response.ok) {
    const body = await response.json()
    log.success(`${(body as any).message}`)

    const receiptHeader = response.headers.get('Payment-Receipt')
    if (receiptHeader) {
      const receipt = Receipt.deserialize(receiptHeader)
      log.tx(receipt.reference, log.explorerLink(receipt.reference))
    }
  } else {
    log.error(`Request failed: ${response.status}`)
  }

  log.separator()
  process.exit(0)
}

main().catch((err) => {
  log.error(`Fatal: ${err.message}`)
  process.exit(1)
})
