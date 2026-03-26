import type { Client, Wallet } from 'xrpl'
import type { XrplCurrency } from '../types.js'
import { isIOU, isXrp } from './currency.js'

/** Default fee estimate in drops (12 drops per tx). */
const DEFAULT_FEE_DROPS = 12n

/**
 * Pre-flight validation for the **client** side. Read-only checks, no side effects.
 *
 * 1. Destination account exists on-chain
 * 2. Sufficient XRP balance for reserves, fees, and (if XRP) payment amount
 * 3. Rippling is enabled on the issuer for IOU payments
 */
export async function runPreflight(params: {
  client: Client
  wallet: Wallet
  currency: XrplCurrency
  destination: string
  amount?: string
}): Promise<void> {
  const { client, wallet, currency, destination, amount } = params

  await verifyDestination(client, destination)
  await checkSufficientBalance({ client, wallet, currency, amount })

  if (isIOU(currency)) {
    const ripplingEnabled = await checkRippling(client, currency.issuer)
    if (!ripplingEnabled) {
      throw new Error(
        `[PAYMENT_PATH_FAILED] Issuer ${currency.issuer} does not have DefaultRipple enabled. ` +
          'IOU payments require rippling on the issuer account.',
      )
    }
  }
}

/**
 * Query the network for current reserve values (base + increment) in drops.
 * Uses server_state RPC which returns reserves in drops directly.
 */
async function getReserves(client: Client): Promise<{ base: bigint; inc: bigint }> {
  const response = await client.request({ command: 'server_state' } as any)
  const state = (response.result as any).state?.validated_ledger
  if (!state) {
    throw new Error('[SUBMISSION_FAILED] Could not retrieve validated ledger state from server.')
  }
  return {
    base: BigInt(state.reserve_base),
    inc: BigInt(state.reserve_inc),
  }
}

/**
 * Check that the wallet has enough XRP to cover:
 * - Current reserve (base + OwnerCount * inc)
 * - Transaction fee
 * - Payment amount (only if paying in XRP)
 *
 * Throws INSUFFICIENT_BALANCE with an actionable message if not.
 */
async function checkSufficientBalance(params: {
  client: Client
  wallet: Wallet
  currency: XrplCurrency
  amount?: string
}): Promise<void> {
  const { client, wallet, currency, amount } = params

  let balance: bigint
  let ownerCount: number
  try {
    const response = await client.request({
      command: 'account_info',
      account: wallet.classicAddress,
    })
    balance = BigInt(response.result.account_data.Balance as string)
    ownerCount = (response.result.account_data as any).OwnerCount ?? 0
  } catch (err: any) {
    if (err?.data?.error === 'actNotFound') {
      throw new Error(
        `[INSUFFICIENT_BALANCE] Account ${wallet.classicAddress} does not exist on the ledger. ` +
          'Fund it with at least the base reserve (1 XRP) to activate it.',
      )
    }
    throw err
  }

  const reserves = await getReserves(client)
  const totalReserve = reserves.base + BigInt(ownerCount) * reserves.inc
  const totalFees = DEFAULT_FEE_DROPS
  const paymentDrops = isXrp(currency) && amount ? BigInt(amount) : 0n

  const totalNeeded = totalReserve + totalFees + paymentDrops

  if (balance < totalNeeded) {
    const balanceXrp = formatDrops(balance)
    const reserveXrp = formatDrops(totalReserve)
    const availableXrp = formatDrops(balance > totalReserve ? balance - totalReserve : 0n)

    const parts = [
      `[INSUFFICIENT_BALANCE] Not enough XRP to complete this transaction.`,
      `Balance: ${balanceXrp} XRP,`,
      `reserve: ${reserveXrp} XRP (base ${formatDrops(reserves.base)} + ${ownerCount} objects * ${formatDrops(reserves.inc)}),`,
      `available: ${availableXrp} XRP.`,
    ]

    const neededParts: string[] = []
    if (paymentDrops > 0n) neededParts.push(`${formatDrops(paymentDrops)} XRP payment`)
    neededParts.push(`${formatDrops(totalFees)} XRP fee`)

    parts.push(`Needed: ${neededParts.join(' + ')}.`)

    throw new Error(parts.join(' '))
  }
}

/** Format drops as XRP string (e.g., 1200000 -> "1.2"). */
function formatDrops(drops: bigint): string {
  const xrp = Number(drops) / 1_000_000
  return xrp.toString()
}

const LSF_DEFAULT_RIPPLE = 0x00800000

/**
 * Check if the issuer has the DefaultRipple flag set.
 */
async function checkRippling(client: Client, issuer: string): Promise<boolean> {
  try {
    const response = await client.request({
      command: 'account_info',
      account: issuer,
    })
    const flags = response.result.account_data.Flags ?? 0
    return (flags & LSF_DEFAULT_RIPPLE) !== 0
  } catch (err: any) {
    if (err?.data?.error === 'actNotFound') return false
    throw err
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
    throw err
  }
}
