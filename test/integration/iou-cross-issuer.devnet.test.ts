import { Credential, Store } from 'mppx'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Client, Wallet } from 'xrpl'
import { charge as clientCharge } from '../../sdk/src/client/Charge.js'
import { charge as serverCharge } from '../../sdk/src/server/Charge.js'
import { connectDevnet, createFundedWallet } from './devnet-helpers.ts'

/**
 * Devnet end-to-end for cross-issuer IOU payments.
 *
 * Topology:
 *   - issuerA emits USD.A
 *   - issuerB emits USD.B
 *   - sender holds USD.A (via trustline + payment from issuerA)
 *   - recipient holds USD.B only (no trustline with issuerA)
 *   - market maker holds trustlines with both issuers and posts an offer
 *     bridging USD.A -> USD.B at parity
 *
 * The SDK must:
 *   1. Detect the cross-issuer scenario.
 *   2. Call ripple_path_find and pick the cheapest path.
 *   3. Set Paths + SendMax on the Payment.
 *   4. Submit successfully (tesSUCCESS).
 *   5. Recipient is credited with the requested USD.B amount.
 */
describe('integration: cross-issuer IOU payment on devnet', () => {
  let client: Client
  let issuerA: Wallet
  let issuerB: Wallet
  let mm: Wallet
  let sender: Wallet
  let recipient: Wallet

  // Helper: enable DefaultRipple on an issuer.
  async function enableDefaultRipple(wallet: Wallet) {
    const tx = {
      TransactionType: 'AccountSet' as const,
      Account: wallet.classicAddress,
      SetFlag: 8, // asfDefaultRipple
    }
    const r = await client.submitAndWait(tx, { wallet })
    const meta = r.result.meta as any
    if (meta?.TransactionResult !== 'tesSUCCESS') {
      throw new Error(`AccountSet failed: ${meta?.TransactionResult}`)
    }
  }

  // Helper: create a trustline.
  async function trustSet(holder: Wallet, currency: string, issuer: string, limit: string) {
    const tx = {
      TransactionType: 'TrustSet' as const,
      Account: holder.classicAddress,
      LimitAmount: { currency, issuer, value: limit },
    }
    const r = await client.submitAndWait(tx, { wallet: holder })
    const meta = r.result.meta as any
    if (meta?.TransactionResult !== 'tesSUCCESS') {
      throw new Error(`TrustSet failed: ${meta?.TransactionResult}`)
    }
  }

  // Helper: send IOU from `from` to `to`.
  async function sendIou(
    from: Wallet,
    to: string,
    currency: string,
    issuer: string,
    value: string,
  ) {
    const tx = {
      TransactionType: 'Payment' as const,
      Account: from.classicAddress,
      Destination: to,
      Amount: { currency, issuer, value },
    }
    const r = await client.submitAndWait(tx, { wallet: from })
    const meta = r.result.meta as any
    if (meta?.TransactionResult !== 'tesSUCCESS') {
      throw new Error(`Payment failed: ${meta?.TransactionResult}`)
    }
  }

  // Helper: post an OfferCreate from market maker bridging USD.A <-> USD.B
  async function placeBridgeOffer(
    maker: Wallet,
    takerGets: { currency: string; issuer: string; value: string },
    takerPays: { currency: string; issuer: string; value: string },
  ) {
    const tx = {
      TransactionType: 'OfferCreate' as const,
      Account: maker.classicAddress,
      TakerGets: takerGets,
      TakerPays: takerPays,
    }
    const r = await client.submitAndWait(tx, { wallet: maker })
    const meta = r.result.meta as any
    if (meta?.TransactionResult !== 'tesSUCCESS') {
      throw new Error(`OfferCreate failed: ${meta?.TransactionResult}`)
    }
  }

  beforeAll(async () => {
    client = await connectDevnet()
    ;[issuerA, issuerB, mm, sender, recipient] = await Promise.all([
      createFundedWallet(client),
      createFundedWallet(client),
      createFundedWallet(client),
      createFundedWallet(client),
      createFundedWallet(client),
    ])

    // Issuers need DefaultRipple so their trustlines route.
    await enableDefaultRipple(issuerA)
    await enableDefaultRipple(issuerB)

    // Market maker also needs DefaultRipple so its USD.A and USD.B trustlines
    // can serve as a bridge for the orderbook crossing. Without this, MM's
    // trustlines have no_ripple set on the MM side and the cross-issuer path
    // dries on submit (tecPATH_DRY).
    await enableDefaultRipple(mm)

    // Market maker trusts both issuers up to 10_000.
    await trustSet(mm, 'USD', issuerA.classicAddress, '10000')
    await trustSet(mm, 'USD', issuerB.classicAddress, '10000')

    // Recipient only trusts issuerB.
    await trustSet(recipient, 'USD', issuerB.classicAddress, '10000')

    // Sender only trusts issuerA.
    await trustSet(sender, 'USD', issuerA.classicAddress, '10000')

    // Issuers fund the market maker on each side so it can settle the bridge.
    // 5000 USD.A and 5000 USD.B to mm.
    await sendIou(issuerA, mm.classicAddress, 'USD', issuerA.classicAddress, '5000')
    await sendIou(issuerB, mm.classicAddress, 'USD', issuerB.classicAddress, '5000')

    // Sender starts with 200 USD.A.
    await sendIou(issuerA, sender.classicAddress, 'USD', issuerA.classicAddress, '200')

    // Market maker posts an offer: takes USD.A, pays USD.B. Parity (1:1) for
    // the test, so realised slippage stays well within the default 50 bps.
    await placeBridgeOffer(
      mm,
      { currency: 'USD', issuer: issuerB.classicAddress, value: '500' }, // taker gets USD.B
      { currency: 'USD', issuer: issuerA.classicAddress, value: '500' }, // taker pays USD.A
    )
  }, 360_000)

  afterAll(async () => {
    await client?.disconnect()
  })

  it('sender (holds USD.A) pays recipient (holds USD.B) -- SDK auto-resolves the path', async () => {
    const challenge = {
      id: `int-cross-issuer-${Date.now()}`,
      realm: 'integration-test',
      method: 'xrpl' as const,
      intent: 'charge' as const,
      createdAt: new Date().toISOString(),
      request: {
        amount: '10', // 10 USD.B delivered to recipient
        currency: JSON.stringify({ currency: 'USD', issuer: issuerB.classicAddress }),
        recipient: recipient.classicAddress,
        methodDetails: { network: 'devnet' as const },
      },
    }

    const sourceAmountSnapshot: { value?: string; currency?: string } = {}
    const cm = clientCharge({
      seed: sender.seed!,
      network: 'devnet',
      preflight: true,
      slippageBps: 50,
      onProgress: (e) => {
        if (e.type === 'paths_resolved') {
          sourceAmountSnapshot.value = e.sourceAmountValue
          sourceAmountSnapshot.currency = e.sourceAmountCurrency
        }
      },
    })

    const credentialBlob = await cm.createCredential({
      challenge: challenge as any,
      context: { mode: 'pull' },
    } as any)
    const cred = Credential.deserialize(credentialBlob)

    const sm = serverCharge({
      recipient: recipient.classicAddress,
      currency: { currency: 'USD', issuer: issuerB.classicAddress },
      network: 'devnet',
      store: Store.memory(),
    })

    const receipt = await sm.verify({
      credential: cred as any,
      request: challenge.request,
    })

    expect(receipt.status).toBe('success')
    expect(receipt.reference).toMatch(/^[0-9A-F]{64}$/)
    // The path-find should have routed via USD.A on the sender's side.
    expect(sourceAmountSnapshot.currency).toBe('USD')

    // Recipient now holds at least 10 USD.B from issuerB.
    const lines = await client.request({
      command: 'account_lines',
      account: recipient.classicAddress,
      peer: issuerB.classicAddress,
    })
    const usdLine = (lines.result.lines as any[]).find((l) => l.currency === 'USD')
    expect(usdLine).toBeDefined()
    expect(Number(usdLine.balance)).toBeGreaterThanOrEqual(10)
  }, 360_000)
})
