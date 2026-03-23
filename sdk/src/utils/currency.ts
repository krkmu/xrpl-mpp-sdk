import type { IssuedCurrency, MPToken, XrplCurrency } from '../types.js'

/**
 * Parse a currency string from the challenge request into an XrplCurrency.
 *
 * - "XRP" -> 'XRP'
 * - JSON with currency+issuer -> IssuedCurrency
 * - JSON with mpt_issuance_id -> MPToken
 */
export function parseCurrency(currency: string): XrplCurrency {
  if (currency === 'XRP') return 'XRP'

  try {
    const parsed = JSON.parse(currency)
    if (parsed.mpt_issuance_id) return parsed as MPToken
    if (parsed.currency && parsed.issuer) return parsed as IssuedCurrency
  } catch {
    // Not JSON -- could be a 3-letter currency code with issuer
  }

  // Try "CURRENCY:ISSUER" format
  if (currency.includes(':')) {
    const [curr, issuer] = currency.split(':')
    if (curr && issuer) return { currency: curr, issuer }
  }

  throw new Error(`Cannot parse currency: ${currency}`)
}

/**
 * Serialize an XrplCurrency to the string format used in challenge requests.
 */
export function serializeCurrency(currency: XrplCurrency): string {
  if (currency === 'XRP') return 'XRP'
  return JSON.stringify(currency)
}

/**
 * Build an XRPL Amount field for a Payment transaction.
 *
 * - XRP: returns string of drops
 * - IOU: returns { currency, issuer, value }
 * - MPT: returns { mpt_issuance_id, value }
 */
export function buildAmount(
  amount: string,
  currency: XrplCurrency,
):
  | string
  | { currency: string; issuer: string; value: string }
  | { mpt_issuance_id: string; value: string } {
  if (currency === 'XRP') {
    return amount // drops
  }

  if ('mpt_issuance_id' in currency) {
    return {
      mpt_issuance_id: currency.mpt_issuance_id,
      value: amount,
    }
  }

  return {
    currency: currency.currency,
    issuer: currency.issuer,
    value: amount,
  }
}

/**
 * Check if a currency is XRP native.
 */
export function isXrp(currency: XrplCurrency): currency is 'XRP' {
  return currency === 'XRP'
}

/**
 * Check if a currency is an IOU.
 */
export function isIOU(currency: XrplCurrency): currency is IssuedCurrency {
  return typeof currency === 'object' && 'currency' in currency && 'issuer' in currency
}

/**
 * Check if a currency is an MPT.
 */
export function isMPT(currency: XrplCurrency): currency is MPToken {
  return typeof currency === 'object' && 'mpt_issuance_id' in currency
}
