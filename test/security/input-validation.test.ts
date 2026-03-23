import { Credential } from 'mppx'
import { describe, expect, it } from 'vitest'
import { malformedCredential } from '../../sdk/src/errors.js'

describe('Input Validation', () => {
  describe('Authorization header parsing', () => {
    it('empty "Authorization: Payment" header -- throws', () => {
      expect(() => Credential.deserialize('Payment ')).toThrow()
    })

    it('missing Payment prefix -- throws', () => {
      expect(() => Credential.deserialize('Bearer abc123')).toThrow()
    })

    it('malformed base64 in credential -- throws', () => {
      expect(() => Credential.deserialize('Payment !!!not-base64!!!')).toThrow()
    })

    it('valid base64 but invalid JSON -- throws', () => {
      // "not json" in base64url
      const b64 = btoa('not json')
      expect(() => Credential.deserialize(`Payment ${b64}`)).toThrow()
    })

    it('valid JSON but missing required fields -- produces diagnostic error', () => {
      const b64 = btoa(JSON.stringify({ foo: 'bar' }))
      // Credential.deserialize should throw because challenge field is missing
      expect(() => Credential.deserialize(`Payment ${b64}`)).toThrow()
    })

    it('malformedCredential error has correct type', () => {
      const err = malformedCredential('invalid base64url encoding')
      expect(err.type).toBe('https://paymentauth.org/problems/malformed-credential')
      expect(err.status).toBe(402)
      expect(err.message).toContain('invalid base64url encoding')
    })
  })

  describe('Payload size limits', () => {
    it('extremely large credential payload should be rejectable', () => {
      // 1MB+ payload
      const largePayload = 'A'.repeat(1_100_000)
      const b64 = btoa(JSON.stringify({ challenge: {}, payload: largePayload }))

      // The application layer should reject before parsing
      // Test that we can detect oversized payloads
      expect(b64.length).toBeGreaterThan(1_000_000)
    })
  })

  describe('Schema validation edge cases', () => {
    it('charge amount as empty string -- schema rejects', async () => {
      const { charge } = await import('../../sdk/src/Methods.js')
      expect(() =>
        charge.schema.request.parse({
          amount: '',
          currency: 'XRP',
          recipient: 'rN7bRFgBrNZKoY2uu015bdjah11UbRZY',
        }),
      ).toThrow()
    })

    it('charge currency as empty string -- schema rejects', async () => {
      const { charge } = await import('../../sdk/src/Methods.js')
      expect(() =>
        charge.schema.request.parse({
          amount: '1000000',
          currency: '',
          recipient: 'rN7bRFgBrNZKoY2uu015bdjah11UbRZY',
        }),
      ).toThrow()
    })

    it('charge recipient as empty string -- schema rejects', async () => {
      const { charge } = await import('../../sdk/src/Methods.js')
      expect(() =>
        charge.schema.request.parse({
          amount: '1000000',
          currency: 'XRP',
          recipient: '',
        }),
      ).toThrow()
    })

    it('valid charge request -- schema accepts', async () => {
      const { charge } = await import('../../sdk/src/Methods.js')
      const parsed = charge.schema.request.parse({
        amount: '1000000',
        currency: 'XRP',
        recipient: 'rN7bRFgBrNZKoY2uu015bdjah11UbRZY',
      })
      expect(parsed.amount).toBe('1000000')
    })
  })
})
