import type { Client, Wallet } from 'xrpl'
import type { IssuedCurrency } from '../types.js'
import { assertReserveCovers, getReserveState } from './reserves.js'
import { assertIssuerHealth } from './validation.js'

const LSF_DEFAULT_RIPPLE = 0x00800000

/**
 * Ensure a trustline exists for the given IOU. If missing and autoTrustline
 * is true, submits a TrustSet transaction.
 *
 * Pre-flight order:
 * 1. Look up existing trustline -- short-circuit if already present.
 * 2. Verify the issuer is healthy (no global freeze, rippling enabled, detect
 *    RequireAuth). Throws ISSUER_GLOBAL_FROZEN / PAYMENT_PATH_FAILED.
 * 3. Verify the operator can cover the *new* owner reserve before submitting
 *    TrustSet. Throws INSUFFICIENT_RESERVE / INSUFFICIENT_BALANCE.
 * 4. Submit TrustSet. If RequireAuth is set on the issuer, surface
 *    TRUSTLINE_REQUIRES_AUTH so the caller knows the issuer must approve.
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

  const existing = await readTrustline(client, wallet.classicAddress, currency)
  if (existing && existing.authorized !== false) return

  if (!autoTrustline) {
    throw new Error(
      `[MISSING_TRUSTLINE] No trustline for ${currency.currency} from issuer ${currency.issuer}. ` +
        'Set autoTrustline: true to auto-create, or create a trustline manually.',
    )
  }

  const { requiresAuth } = await assertIssuerHealth(client, currency)

  // Reserve check before issuing TrustSet (which adds one owner object).
  const state = await getReserveState(client, wallet.classicAddress)
  if (!state) {
    throw new Error(
      `[INSUFFICIENT_BALANCE] Account ${wallet.classicAddress} is not yet funded. ` +
        'Fund it with at least the base reserve before creating a trustline.',
    )
  }
  assertReserveCovers({
    account: wallet.classicAddress,
    state,
    addedOwnerObjects: existing ? 0 : 1,
    kind: 'TrustSet',
  })

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

  if (requiresAuth) {
    throw new Error(
      `[TRUSTLINE_REQUIRES_AUTH] Issuer ${currency.issuer} has asfRequireAuth set. ` +
        `The trustline for ${currency.currency} was created but cannot hold balance until the issuer ` +
        'submits a TrustSet with the tfSetfAuth flag against this account.',
    )
  }
}

type TrustlineRow = {
  currency: string
  account: string
  balance: string
  limit: string
  /** false when the issuer has not yet authorized this trustline (RequireAuth). */
  authorized: boolean | undefined
  freeze: boolean
}

/**
 * Look up the trustline for the given account+issuer+currency. Returns null if
 * no line exists (caller decides whether to create).
 *
 * Note: account_lines normalizes amounts so a "low" account's no_ripple flag
 * surfaces as `no_ripple_peer`. The fields we care about for validation are
 * `authorized`, `freeze`, and balance.
 */
async function readTrustline(
  client: Client,
  account: string,
  currency: IssuedCurrency,
): Promise<TrustlineRow | null> {
  try {
    const r = await client.request({
      command: 'account_lines',
      account,
      peer: currency.issuer,
    })
    const line = (r.result.lines as any[]).find((l) => l.currency === currency.currency)
    if (!line) return null
    return {
      currency: line.currency,
      account: line.account,
      balance: line.balance,
      limit: line.limit,
      authorized: line.authorized,
      freeze: Boolean(line.freeze ?? line.freeze_peer),
    }
  } catch (err: any) {
    if (err?.data?.error === 'actNotFound') return null
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
