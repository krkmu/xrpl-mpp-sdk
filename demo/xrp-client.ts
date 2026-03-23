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

async function main() {
  // 1. Connect to XRPL testnet and fund a payer wallet
  const xrplClient = new Client(XRPL_RPC_URLS.testnet)
  await xrplClient.connect()
  const { wallet } = await xrplClient.fundWallet()
  await xrplClient.disconnect()

  console.log(`[client] Wallet: ${wallet.classicAddress}`)

  // 2. Create the XRPL charge method for the client
  const chargeMethod = charge({
    seed: wallet.seed!,
    mode: 'pull',
    network: 'testnet',
  })

  // 3. Create the mppx client -- this patches globalThis.fetch to auto-handle 402
  Mppx.create({
    methods: [chargeMethod],
  })

  // 4. Request the paid resource
  console.log('[client] Requesting http://localhost:3000/resource...')
  const response = await fetch('http://localhost:3000/resource')

  console.log(`[client] Response status: ${response.status}`)

  if (response.ok) {
    const body = await response.json()
    console.log('[client] Body:', JSON.stringify(body, null, 2))

    // 5. Extract and display the payment receipt
    const receiptHeader = response.headers.get('Payment-Receipt')
    if (receiptHeader) {
      const receipt = Receipt.deserialize(receiptHeader)
      console.log('[client] Receipt:', JSON.stringify(receipt, null, 2))
      console.log(`[client] Explorer: https://testnet.xrpl.org/transactions/${receipt.reference}`)
    }
  } else {
    const text = await response.text()
    console.log('[client] Error response:', text)
  }

  process.exit(0)
}

main().catch((err) => {
  console.error('[client] Fatal error:', err)
  process.exit(1)
})
