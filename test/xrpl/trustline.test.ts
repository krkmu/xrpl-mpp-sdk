import { describe, expect, it } from 'vitest'

describe('XRPL Trustline', () => {
  // These tests will be expanded in Phase 1 when trustline utils are implemented.
  // For now, they test the constants and type shapes.

  it('lsfDefaultRipple flag is 0x00800000', () => {
    const LSF_DEFAULT_RIPPLE = 0x00800000
    expect(LSF_DEFAULT_RIPPLE).toBe(8388608)
  })

  it('IOU amount object has currency and issuer', () => {
    const amount = {
      currency: 'USD',
      issuer: 'rN7bRFgBrNZKoY2uu015bdjah11UbRZY',
      value: '100',
    }
    expect(amount.currency).toBe('USD')
    expect(amount.issuer).toBeDefined()
    expect(amount.value).toBe('100')
  })
})
