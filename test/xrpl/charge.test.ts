import { describe, expect, it } from 'vitest'
import { fromTecResult, mapTecResult } from '../../sdk/src/errors.js'
import { charge, fromDrops, toDrops } from '../../sdk/src/Methods.js'

describe('XRPL Charge', () => {
  describe('toDrops / fromDrops', () => {
    it('converts 1 XRP to 1000000 drops', () => {
      expect(toDrops('1')).toBe('1000000')
    })

    it('converts 0.001 XRP to 1000 drops', () => {
      expect(toDrops('0.001')).toBe('1000')
    })

    it('converts 0.000001 XRP to 1 drop', () => {
      expect(toDrops('0.000001')).toBe('1')
    })

    it('converts 100 XRP to 100000000 drops', () => {
      expect(toDrops('100')).toBe('100000000')
    })

    it('handles negative amounts', () => {
      expect(toDrops('-1')).toBe('-1000000')
    })

    it('converts 1000000 drops to 1.000000 XRP', () => {
      expect(fromDrops('1000000')).toBe('1.000000')
    })

    it('converts 1 drop to 0.000001 XRP', () => {
      expect(fromDrops('1')).toBe('0.000001')
    })

    it('converts 0 drops to 0.000000', () => {
      expect(fromDrops('0')).toBe('0.000000')
    })

    it('roundtrips correctly', () => {
      expect(fromDrops(toDrops('12.345678'))).toBe('12.345678')
      expect(fromDrops(toDrops('0.000001'))).toBe('0.000001')
      expect(fromDrops(toDrops('1000'))).toBe('1000.000000')
    })
  })

  describe('tecResult mapping', () => {
    it('maps tecPATH_DRY to PAYMENT_PATH_FAILED', () => {
      expect(mapTecResult('tecPATH_DRY')).toBe('PAYMENT_PATH_FAILED')
    })

    it('maps tecUNFUNDED_PAYMENT to INSUFFICIENT_BALANCE', () => {
      expect(mapTecResult('tecUNFUNDED_PAYMENT')).toBe('INSUFFICIENT_BALANCE')
    })

    it('maps tecNO_DST to RECIPIENT_NOT_FOUND', () => {
      expect(mapTecResult('tecNO_DST')).toBe('RECIPIENT_NOT_FOUND')
    })

    it('maps tecNO_AUTH to TRUSTLINE_NOT_AUTHORIZED', () => {
      expect(mapTecResult('tecNO_AUTH')).toBe('TRUSTLINE_NOT_AUTHORIZED')
    })

    it('maps tecNO_LINE to MISSING_TRUSTLINE', () => {
      expect(mapTecResult('tecNO_LINE')).toBe('MISSING_TRUSTLINE')
    })

    it('maps temBAD_AMOUNT to INVALID_AMOUNT', () => {
      expect(mapTecResult('temBAD_AMOUNT')).toBe('INVALID_AMOUNT')
    })

    it('returns undefined for unknown tecResult', () => {
      expect(mapTecResult('tecUNKNOWN_CODE')).toBeUndefined()
    })
  })

  describe('fromTecResult error construction', () => {
    it('creates InsufficientBalanceError for tecUNFUNDED_PAYMENT', () => {
      const err = fromTecResult('tecUNFUNDED_PAYMENT', 'Not enough XRP')
      expect(err.message).toContain('INSUFFICIENT_BALANCE')
      expect(err.message).toContain('tecUNFUNDED_PAYMENT')
    })

    it('creates VerificationFailedError for tecPATH_DRY', () => {
      const err = fromTecResult('tecPATH_DRY')
      expect(err.message).toContain('PAYMENT_PATH_FAILED')
    })

    it('creates VerificationFailedError with SUBMISSION_FAILED for unknown tec', () => {
      const err = fromTecResult('tecSOMETHING_ELSE')
      expect(err.message).toContain('SUBMISSION_FAILED')
    })
  })

  describe('Charge schema', () => {
    it('pull mode: blob is a string', () => {
      const parsed = charge.schema.credential.payload.parse({
        blob: '1200002200000000',
        type: 'transaction',
      })
      expect(parsed).toEqual({ blob: '1200002200000000', type: 'transaction' })
    })

    it('push mode: hash is a string', () => {
      const parsed = charge.schema.credential.payload.parse({
        hash: 'A'.repeat(64),
        type: 'hash',
      })
      expect(parsed).toEqual({ hash: 'A'.repeat(64), type: 'hash' })
    })
  })
})
