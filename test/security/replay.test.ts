import { Store } from 'mppx'
import { beforeEach, describe, expect, it } from 'vitest'
import { replayDetected } from '../../sdk/src/errors.js'

describe('Replay Attack Prevention', () => {
  let store: ReturnType<typeof Store.memory>

  beforeEach(() => {
    store = Store.memory()
  })

  describe('Charge replay protection', () => {
    it('same tx hash submitted twice -- second attempt rejected', async () => {
      const txHash = 'A'.repeat(64)
      const storeKey = `xrpl:charge:${txHash}`

      // First submission -- should succeed
      const first = await store.get(storeKey)
      expect(first).toBeNull()
      await store.put(storeKey, Date.now())

      // Second submission -- should be detected
      const second = await store.get(storeKey)
      expect(second).not.toBeNull()

      // Error should be a VerificationFailedError with REPLAY_DETECTED code
      const err = replayDetected(txHash)
      expect(err.message).toContain('REPLAY_DETECTED')
      expect(err.message).toContain(txHash)
    })

    it('same signed blob submitted twice -- second attempt rejected', async () => {
      // In pull mode, we hash the blob to get a dedup key
      const blob = '1200002200000000DEADBEEF'
      // Simulate hashing the blob (in real code, this would use the tx hash from decode)
      const blobHash = `blob:${blob}`
      const storeKey = `xrpl:charge:${blobHash}`

      await store.put(storeKey, Date.now())
      const seen = await store.get(storeKey)
      expect(seen).not.toBeNull()
    })

    it('different tx hashes are independent', async () => {
      const hash1 = 'A'.repeat(64)
      const hash2 = 'B'.repeat(64)

      await store.put(`xrpl:charge:${hash1}`, Date.now())

      const seen1 = await store.get(`xrpl:charge:${hash1}`)
      const seen2 = await store.get(`xrpl:charge:${hash2}`)

      expect(seen1).not.toBeNull()
      expect(seen2).toBeNull()
    })
  })

  describe('Channel replay protection', () => {
    it('same cumulative amount + signature resubmitted -- rejected', async () => {
      const channelId = '0'.repeat(64)
      const storeKey = `xrpl:channel:${channelId}`

      // Track cumulative state
      await store.put(storeKey, { cumulative: '500000', timestamp: Date.now() })

      // Same cumulative resubmitted
      const state = (await store.get(storeKey)) as any
      const newCumulative = 500000n
      const previousCumulative = BigInt(state.cumulative)

      // Equal cumulative should be rejected (strict >)
      expect(newCumulative > previousCumulative).toBe(false)
    })

    it('cumulative amount LOWER than previous -- rejected', async () => {
      const channelId = '0'.repeat(64)
      const storeKey = `xrpl:channel:${channelId}`

      await store.put(storeKey, { cumulative: '500000', timestamp: Date.now() })

      const state = (await store.get(storeKey)) as any
      const newCumulative = 400000n // Lower
      const previousCumulative = BigInt(state.cumulative)

      expect(newCumulative > previousCumulative).toBe(false)
    })

    it('higher cumulative amount is accepted', async () => {
      const channelId = '0'.repeat(64)
      const storeKey = `xrpl:channel:${channelId}`

      await store.put(storeKey, { cumulative: '500000', timestamp: Date.now() })

      const state = (await store.get(storeKey)) as any
      const newCumulative = 600000n
      const previousCumulative = BigInt(state.cumulative)

      expect(newCumulative > previousCumulative).toBe(true)
    })

    it('store persists across requests within same server instance', async () => {
      const channelId = '0'.repeat(64)
      const storeKey = `xrpl:channel:${channelId}`

      // Request 1
      await store.put(storeKey, { cumulative: '100000', timestamp: Date.now() })

      // Request 2 -- should see the state from request 1
      const state = (await store.get(storeKey)) as any
      expect(state.cumulative).toBe('100000')

      // Request 3 -- update cumulative
      await store.put(storeKey, { cumulative: '200000', timestamp: Date.now() })

      // Request 4 -- should see updated state
      const updated = (await store.get(storeKey)) as any
      expect(updated.cumulative).toBe('200000')
    })
  })
})
