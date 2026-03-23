import type { Client, Wallet } from 'xrpl'
import type { XrplCurrency } from '../types.js'
import { isIOU, isMPT } from './currency.js'
import { ensureMPTHolding } from './mpt.js'
import { checkRippling, ensureTrustline } from './trustline.js'

/**
 * Pre-flight validation orchestrator. Checks:
 * 1. Trustline exists for IOU payments (auto-creates if configured)
 * 2. Rippling is enabled on the issuer for IOU payments
 * 3. MPT holding exists for MPT payments (auto-authorizes if configured)
 * 4. Destination account exists on-chain
 */
export async function runPreflight(params: {
  client: Client
  wallet: Wallet
  currency: XrplCurrency
  destination: string
  autoTrustline: boolean
  autoTrustlineLimit?: string
  autoMPTAuthorize: boolean
}): Promise<void> {
  const {
    client,
    wallet,
    currency,
    destination,
    autoTrustline,
    autoTrustlineLimit,
    autoMPTAuthorize,
  } = params

  // Verify destination exists
  await verifyDestination(client, destination)

  // IOU-specific checks
  if (isIOU(currency)) {
    await ensureTrustline({
      client,
      wallet,
      currency,
      autoTrustline,
      trustlineLimit: autoTrustlineLimit,
    })

    const ripplingEnabled = await checkRippling(client, currency.issuer)
    if (!ripplingEnabled) {
      throw new Error(
        `[PAYMENT_PATH_FAILED] Issuer ${currency.issuer} does not have DefaultRipple enabled. ` +
          'IOU payments require rippling on the issuer account.',
      )
    }
  }

  // MPT-specific checks
  if (isMPT(currency)) {
    await ensureMPTHolding({
      client,
      wallet,
      mpt: currency,
      autoMPTAuthorize,
    })
  }
}

/**
 * Verify that a destination account exists on the ledger.
 * Prevents funds sent to non-existent accounts (tecNO_DST).
 */
async function verifyDestination(client: Client, address: string): Promise<void> {
  try {
    await client.request({
      command: 'account_info',
      account: address,
    })
  } catch (err: any) {
    if (err?.data?.error === 'actNotFound') {
      throw new Error(
        `[RECIPIENT_NOT_FOUND] Destination account ${address} does not exist on the ledger.`,
      )
    }
    // Other errors (e.g., network) -- let them propagate
    throw err
  }
}
