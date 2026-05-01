import { Credential, Store } from 'mppx'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Client, Wallet } from 'xrpl'
import { charge as clientCharge } from '../../sdk/src/client/Charge.js'
import { charge as serverCharge } from '../../sdk/src/server/Charge.js'
import { connectDevnet, createFundedWallet, devnetSource } from './devnet-helpers.ts'

/**
 * Real devnet charge end-to-end test. Funds two ephemeral wallets, builds a
 * 402 challenge by hand (the framework would normally do this), runs the
 * client createCredential() to sign and prepare the tx, then runs the
 * server verify() which decodes the blob, validates fields, submits, and
 * polls.
 *
 * If devnet or its faucet are unavailable, the test will fail with a
 * descriptive error rather than silently skipping.
 */
describe('integration: XRP charge (pull mode) on devnet', () => {
  let client: Client
  let payer: Wallet
  let recipient: Wallet

  beforeAll(async () => {
    client = await connectDevnet()
    ;[payer, recipient] = await Promise.all([
      createFundedWallet(client),
      createFundedWallet(client),
    ])
  })

  afterAll(async () => {
    await client?.disconnect()
  })

  it('client creates a Payment credential, server verifies and settles on-chain', async () => {
    const amountDrops = '500000' // 0.5 XRP

    // Build the 402 challenge by hand. In production mppx would emit this
    // and bind methodDetails before signing.
    const challenge = {
      id: `int-charge-${Date.now()}`,
      realm: 'integration-test',
      method: 'xrpl' as const,
      intent: 'charge' as const,
      createdAt: new Date().toISOString(),
      request: {
        amount: amountDrops,
        currency: 'XRP',
        recipient: recipient.classicAddress,
        methodDetails: { network: 'devnet' as const },
      },
    }

    const clientMethod = clientCharge({
      seed: payer.seed!,
      network: 'devnet',
      preflight: true,
    })

    // Drive the credential creation directly. (mppx's client wrapper would
    // normally call this for us with an HTTP transport.)
    const credentialBlob = await clientMethod.createCredential({
      challenge: challenge as any,
      context: { mode: 'pull' },
    } as any)

    // The credential is base64url JSON; deserialize it back to the object
    // shape the server expects.
    const credential = Credential.deserialize(credentialBlob)
    expect(credential.source).toBe(devnetSource(payer))

    const serverMethod = serverCharge({
      recipient: recipient.classicAddress,
      network: 'devnet',
      store: Store.memory(),
    })

    const receipt = await serverMethod.verify({
      credential: credential as any,
      request: challenge.request,
    })

    expect(receipt.status).toBe('success')
    expect(receipt.method).toBe('xrpl')
    expect(receipt.reference).toMatch(/^[0-9A-F]{64}$/)
  }, 180_000)
})
