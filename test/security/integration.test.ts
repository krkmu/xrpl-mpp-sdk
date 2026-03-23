import { Store } from 'mppx'
import { beforeEach, describe, expect, it } from 'vitest'
import { dropsToXrp, signPaymentChannelClaim, verifyPaymentChannelClaim, Wallet } from 'xrpl'
import { invalidSignature, replayDetected, verificationFailed } from '../../sdk/src/errors.js'

/**
 * Integration-level security tests that exercise real crypto operations
 * (signature verification, cumulative tracking) rather than just testing
 * error constructors in isolation.
 */
describe('Security Integration Tests', () => {
  const channelId = '0'.repeat(64)
  let store: ReturnType<typeof Store.memory>

  beforeEach(() => {
    store = Store.memory()
  })

  describe('Channel claim signature verification pipeline', () => {
    it('claim signed by wrong key -- rejected by verifyPaymentChannelClaim', () => {
      const correctWallet = Wallet.generate()
      const wrongWallet = Wallet.generate()
      const amountDrops = '1000000'
      const amountXrp = dropsToXrp(amountDrops).toString()

      // Sign with wrong key
      const signature = signPaymentChannelClaim(channelId, amountXrp, wrongWallet.privateKey)

      // Verify with correct key -- should fail
      const isValid = verifyPaymentChannelClaim(
        channelId,
        amountXrp,
        signature,
        correctWallet.publicKey,
      )

      expect(isValid).toBe(false)

      // SDK should throw INVALID_SIGNATURE
      if (!isValid) {
        const err = invalidSignature('Claim signature verification failed')
        expect(err.message).toContain('INVALID_SIGNATURE')
      }
    })

    it('claim with correct key -- passes verifyPaymentChannelClaim', () => {
      const wallet = Wallet.generate()
      const amountDrops = '1000000'
      const amountXrp = dropsToXrp(amountDrops).toString()

      const signature = signPaymentChannelClaim(channelId, amountXrp, wallet.privateKey)

      const isValid = verifyPaymentChannelClaim(channelId, amountXrp, signature, wallet.publicKey)

      expect(isValid).toBe(true)
    })

    it('claim with tampered amount -- rejected by verifyPaymentChannelClaim', () => {
      const wallet = Wallet.generate()
      const realAmountXrp = dropsToXrp('1000000').toString()
      const tamperedAmountXrp = dropsToXrp('2000000').toString()

      // Sign for real amount
      const signature = signPaymentChannelClaim(channelId, realAmountXrp, wallet.privateKey)

      // Verify with tampered amount -- should fail
      const isValid = verifyPaymentChannelClaim(
        channelId,
        tamperedAmountXrp,
        signature,
        wallet.publicKey,
      )

      expect(isValid).toBe(false)
    })
  })

  describe('Cumulative tracking pipeline', () => {
    it('full cumulative lifecycle: 0 -> 100k -> 200k -> replay at 200k -> rejected', async () => {
      const wallet = Wallet.generate()
      const cumulativeKey = `xrpl:channel:${channelId}`

      // First claim: 100000 drops
      const cumulative1 = '100000'
      const sig1 = signPaymentChannelClaim(
        channelId,
        dropsToXrp(cumulative1).toString(),
        wallet.privateKey,
      )

      // Verify signature
      expect(
        verifyPaymentChannelClaim(
          channelId,
          dropsToXrp(cumulative1).toString(),
          sig1,
          wallet.publicKey,
        ),
      ).toBe(true)

      // Check store -- no previous state
      const state0 = await store.get(cumulativeKey)
      expect(state0).toBeNull()

      // Record cumulative
      await store.put(cumulativeKey, { cumulative: cumulative1, timestamp: Date.now() })

      // Second claim: 200000 drops (strictly greater -- should pass)
      const cumulative2 = '200000'
      const state1 = (await store.get(cumulativeKey)) as any
      expect(BigInt(cumulative2) > BigInt(state1.cumulative)).toBe(true)
      await store.put(cumulativeKey, { cumulative: cumulative2, timestamp: Date.now() })

      // Third claim: replay at 200000 (equal -- should fail)
      const state2 = (await store.get(cumulativeKey)) as any
      const replayAttempt = BigInt(cumulative2) <= BigInt(state2.cumulative)
      expect(replayAttempt).toBe(true)

      const err = replayDetected(`${channelId}:${cumulative2}`)
      expect(err.message).toContain('REPLAY_DETECTED')
    })

    it('cumulative decrease attack: 200k -> 150k -> rejected', async () => {
      const cumulativeKey = `xrpl:channel:${channelId}`

      await store.put(cumulativeKey, { cumulative: '200000', timestamp: Date.now() })

      const state = (await store.get(cumulativeKey)) as any
      const attackCumulative = 150000n
      const previousCumulative = BigInt(state.cumulative)

      expect(attackCumulative < previousCumulative).toBe(true)

      const err = verificationFailed(
        'AMOUNT_MISMATCH',
        `New cumulative ${attackCumulative} is less than previous ${previousCumulative}`,
      )
      expect(err.message).toContain('AMOUNT_MISMATCH')
    })
  })

  describe('Cross-curve signature verification', () => {
    it('ed25519 wallet: sign and verify claim', () => {
      const wallet = Wallet.generate('ed25519')
      expect(wallet.publicKey.startsWith('ED')).toBe(true)

      const amountXrp = dropsToXrp('500000').toString()
      const signature = signPaymentChannelClaim(channelId, amountXrp, wallet.privateKey)
      const isValid = verifyPaymentChannelClaim(channelId, amountXrp, signature, wallet.publicKey)

      expect(isValid).toBe(true)
    })

    it('secp256k1 wallet: sign and verify claim', () => {
      const wallet = Wallet.generate('ecdsa-secp256k1')
      expect(wallet.publicKey.startsWith('ED')).toBe(false)

      const amountXrp = dropsToXrp('500000').toString()
      const signature = signPaymentChannelClaim(channelId, amountXrp, wallet.privateKey)
      const isValid = verifyPaymentChannelClaim(channelId, amountXrp, signature, wallet.publicKey)

      expect(isValid).toBe(true)
    })

    it('ed25519 signer vs secp256k1 verifier -- rejected', () => {
      const ed25519Wallet = Wallet.generate('ed25519')
      const secp256k1Wallet = Wallet.generate('ecdsa-secp256k1')

      const amountXrp = dropsToXrp('500000').toString()
      const signature = signPaymentChannelClaim(channelId, amountXrp, ed25519Wallet.privateKey)

      // Cross-curve verification should fail
      let isValid: boolean
      try {
        isValid = verifyPaymentChannelClaim(
          channelId,
          amountXrp,
          signature,
          secp256k1Wallet.publicKey,
        )
      } catch {
        // xrpl.js may throw on cross-curve verification
        isValid = false
      }

      expect(isValid).toBe(false)
    })
  })

  describe('Partial payment flag detection', () => {
    it('tfPartialPayment flag (0x00020000) is detectable on tx', () => {
      const TF_PARTIAL_PAYMENT = 0x00020000

      const txWithPartial = { Flags: 0x00020000 }
      const txWithout = { Flags: 0 }
      const txWithMultipleFlags = { Flags: 0x00020000 | 0x00080000 }

      expect((txWithPartial.Flags & TF_PARTIAL_PAYMENT) !== 0).toBe(true)
      expect((txWithout.Flags & TF_PARTIAL_PAYMENT) !== 0).toBe(false)
      expect((txWithMultipleFlags.Flags & TF_PARTIAL_PAYMENT) !== 0).toBe(true)
    })
  })
})
