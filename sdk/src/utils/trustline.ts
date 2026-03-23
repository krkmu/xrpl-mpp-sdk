import type { Client, Wallet } from 'xrpl'
import type { IssuedCurrency } from '../types.js'

const LSF_DEFAULT_RIPPLE = 0x00800000

/**
 * Ensure a trustline exists for the given IOU. If missing and autoTrustline
 * is true, submits a TrustSet transaction.
 *
 * Throws MISSING_TRUSTLINE if the trustline is missing and autoTrustline is false.
 */
export async function ensureTrustline(params: {
  client: Client
  wallet: Wallet
  currency: IssuedCurrency
  autoTrustline: boolean
  /** Maximum balance willing to hold from issuer. @default '10000' */
  trustlineLimit?: string
}): Promise<void> {
  const { client, wallet, currency, autoTrustline, trustlineLimit } = params

  const hasTrustline = await checkTrustline(client, wallet.classicAddress, currency)
  if (hasTrustline) return

  if (!autoTrustline) {
    throw new Error(
      `[MISSING_TRUSTLINE] No trustline for ${currency.currency} from issuer ${currency.issuer}. ` +
        'Set autoTrustline: true to auto-create, or create a trustline manually.',
    )
  }

  const trustSet = {
    TransactionType: 'TrustSet' as const,
    Account: wallet.classicAddress,
    LimitAmount: {
      currency: currency.currency,
      issuer: currency.issuer,
      value: trustlineLimit ?? '10000',
    },
  }

  const result = await client.submitAndWait(trustSet, { wallet })
  const meta = result.result.meta as any
  if (meta?.TransactionResult !== 'tesSUCCESS') {
    throw new Error(`[TRUSTLINE_FAILED] TrustSet failed: ${meta?.TransactionResult ?? 'unknown'}`)
  }
}

/**
 * Check if a trustline exists for the given account and currency.
 */
async function checkTrustline(
  client: Client,
  account: string,
  currency: IssuedCurrency,
): Promise<boolean> {
  try {
    const response = await client.request({
      command: 'account_lines',
      account,
      peer: currency.issuer,
    })
    return response.result.lines.some((line: any) => line.currency === currency.currency)
  } catch (err: any) {
    // Account not found -- no trustline possible
    if (err?.data?.error === 'actNotFound') return false
    // Re-throw network errors
    throw err
  }
}

/**
 * Check if the issuer has the DefaultRipple flag set (lsfDefaultRipple = 0x00800000).
 * Required for IOU payments to work properly.
 */
export async function checkRippling(client: Client, issuer: string): Promise<boolean> {
  try {
    const response = await client.request({
      command: 'account_info',
      account: issuer,
    })
    const flags = response.result.account_data.Flags ?? 0
    return (flags & LSF_DEFAULT_RIPPLE) !== 0
  } catch (err: any) {
    // Account not found -- rippling not possible
    if (err?.data?.error === 'actNotFound') return false
    // Re-throw network errors
    throw err
  }
}
