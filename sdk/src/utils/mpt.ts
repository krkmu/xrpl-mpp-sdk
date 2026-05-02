import type { Client, Wallet } from 'xrpl'
import type { MPToken } from '../types.js'
import { assertReserveCovers, getReserveState } from './reserves.js'

/** lsfMPTRequireAuth on MPTokenIssuance.Flags */
const LSF_MPT_REQUIRE_AUTH = 0x00000002

/**
 * Ensure the account holds the given MPT. If not authorized and autoMPTAuthorize
 * is true, submits an MPTokenAuthorize transaction.
 *
 * Pre-flight order:
 * 1. Look up holder's MPToken object -- short-circuit if already present.
 * 2. Look up the MPTokenIssuance to detect lsfMPTRequireAuth.
 * 3. Reserve check before submitting MPTokenAuthorize (adds one owner object).
 * 4. Submit MPTokenAuthorize. If the issuance requires authorization, surface
 *    MPT_NOT_AUTHORIZED so the caller knows the issuer must run a paired
 *    MPTokenAuthorize step from their side.
 *
 * Throws MPT_NOT_AUTHORIZED if autoMPTAuthorize is false and no holder object
 * exists, or if the issuer has RequireAuth and has not approved.
 */
export async function ensureMPTHolding(params: {
  client: Client
  wallet: Wallet
  mpt: MPToken
  autoMPTAuthorize: boolean
}): Promise<void> {
  const { client, wallet, mpt, autoMPTAuthorize } = params

  const hasHolding = await checkMPTHolding(client, wallet.classicAddress, mpt)
  if (hasHolding) return

  if (!autoMPTAuthorize) {
    throw new Error(
      `[MPT_NOT_AUTHORIZED] Account ${wallet.classicAddress} does not hold MPT ${mpt.mpt_issuance_id}. ` +
        'Set autoMPTAuthorize: true to auto-authorize, or submit MPTokenAuthorize manually.',
    )
  }

  const issuanceFlags = await readMPTokenIssuanceFlags(client, mpt.mpt_issuance_id)
  if (issuanceFlags === null) {
    throw new Error(
      `[MPT_NOT_AUTHORIZED] MPTokenIssuance ${mpt.mpt_issuance_id} does not exist on the ledger.`,
    )
  }
  const issuerRequiresAuth = (issuanceFlags & LSF_MPT_REQUIRE_AUTH) !== 0

  const state = await getReserveState(client, wallet.classicAddress)
  if (!state) {
    throw new Error(
      `[INSUFFICIENT_BALANCE] Account ${wallet.classicAddress} is not yet funded. ` +
        'Fund it before authorising an MPT.',
    )
  }
  assertReserveCovers({
    account: wallet.classicAddress,
    state,
    addedOwnerObjects: 1,
    kind: 'MPTokenAuthorize',
  })

  const mpTokenAuthorize = {
    TransactionType: 'MPTokenAuthorize' as const,
    Account: wallet.classicAddress,
    MPTokenIssuanceID: mpt.mpt_issuance_id,
  }

  const result = await client.submitAndWait(mpTokenAuthorize, { wallet })
  const meta = result.result.meta as any
  if (meta?.TransactionResult !== 'tesSUCCESS') {
    throw new Error(
      `[MPT_AUTHORIZE_FAILED] MPTokenAuthorize failed: ${meta?.TransactionResult ?? 'unknown'}`,
    )
  }

  if (issuerRequiresAuth) {
    throw new Error(
      `[MPT_NOT_AUTHORIZED] MPTokenIssuance ${mpt.mpt_issuance_id} has lsfMPTRequireAuth set. ` +
        `The holder side of authorization completed, but the issuer must also submit ` +
        `MPTokenAuthorize against this account before payments can succeed.`,
    )
  }
}

/** Look up the issuance ledger entry to read its Flags. Returns null if missing. */
async function readMPTokenIssuanceFlags(
  client: Client,
  issuanceId: string,
): Promise<number | null> {
  try {
    const r = await client.request({
      command: 'ledger_entry',
      mpt_issuance: issuanceId,
    } as any)
    const node = (r.result as any).node
    if (!node) return null
    return (node.Flags as number) ?? 0
  } catch (err: any) {
    if (err?.data?.error === 'entryNotFound') return null
    // Some servers don't yet support mpt_issuance lookup; fall back to null
    // and let the submit error surface if the issuance is missing.
    if (err?.data?.error === 'unknownOption' || err?.data?.error === 'invalidParams') return null
    throw err
  }
}

/**
 * Check if an account holds the given MPT.
 */
async function checkMPTHolding(client: Client, account: string, mpt: MPToken): Promise<boolean> {
  try {
    const response = await client.request({
      command: 'account_objects',
      account,
      type: 'mptoken',
    } as any)
    return (response.result as any).account_objects.some(
      (obj: any) => obj.MPTokenIssuanceID === mpt.mpt_issuance_id,
    )
  } catch (err: any) {
    if (err?.data?.error === 'actNotFound') return false
    throw err
  }
}
