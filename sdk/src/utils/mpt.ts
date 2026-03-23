import type { Client, Wallet } from 'xrpl'
import type { MPToken } from '../types.js'

/**
 * Ensure the account holds the given MPT. If not authorized and autoMPTAuthorize
 * is true, submits an MPTokenAuthorize transaction.
 *
 * Throws MPT_NOT_AUTHORIZED if the MPT holding is missing and autoMPTAuthorize is false.
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
    // Account not found -- no MPT holding possible
    if (err?.data?.error === 'actNotFound') return false
    // Re-throw network errors
    throw err
  }
}
