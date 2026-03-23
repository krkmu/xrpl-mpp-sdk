import { Method } from 'mppx'
import { z } from 'zod/mini'

/**
 * XRPL charge intent for on-chain Payment transactions.
 *
 * Supports two credential flows:
 * - `type: "transaction"` -- pull mode (default):
 *   Client signs a Payment tx and sends the serialized blob.
 *   The server submits it to the ledger.
 * - `type: "hash"` -- push mode:
 *   Client submits the Payment tx itself and sends the tx hash.
 *   The server verifies it on-chain.
 *
 * Supports XRP native, IOU (issued currencies), and MPT (multi-purpose tokens).
 */
export const charge = Method.from({
  name: 'xrpl',
  intent: 'charge',
  schema: {
    credential: {
      payload: z.discriminatedUnion('type', [
        /** Pull mode: client signs Payment tx, server broadcasts. */
        z.object({ blob: z.string(), type: z.literal('transaction') }),
        /** Push mode: client broadcasts and sends the tx hash. */
        z.object({ hash: z.string(), type: z.literal('hash') }),
      ]),
    },
    request: z.object({
      /** Payment amount in drops (XRP) or base units (IOU/MPT). */
      amount: z.string().check(z.minLength(1, 'amount must not be empty')),
      /** Currency identifier: "XRP", or JSON-encoded IssuedCurrency/MPT. */
      currency: z.string().check(z.minLength(1, 'currency must not be empty')),
      /** Recipient XRPL classic address (r...). */
      recipient: z.string().check(z.minLength(1, 'recipient must not be empty')),
      /** Optional human-readable description. */
      description: z.optional(z.string()),
      /** Merchant-provided reconciliation ID. */
      externalId: z.optional(z.string()),
      /** Method-specific details injected by the server. */
      methodDetails: z.optional(
        z.object({
          /** Server-generated unique tracking ID. */
          reference: z.optional(z.string()),
          /** XRPL network identifier ("mainnet" | "testnet" | "devnet"). */
          network: z.optional(z.string()),
          /** Optional InvoiceID to bind payment to challenge. */
          invoiceId: z.optional(z.string()),
        }),
      ),
    }),
  },
})

// -- Helpers --

/**
 * Convert XRP to drops.
 *
 * @example
 * ```ts
 * toDrops('1')     // '1000000'
 * toDrops('0.001') // '1000'
 * ```
 */
export function toDrops(xrp: string): string {
  if (xrp.startsWith('-')) {
    return `-${toDrops(xrp.slice(1))}`
  }
  const [whole = '0', frac = ''] = xrp.split('.')
  const paddedFrac = frac.padEnd(6, '0').slice(0, 6)
  return (BigInt(whole) * 1_000_000n + BigInt(paddedFrac)).toString()
}

/**
 * Convert drops to XRP.
 *
 * @example
 * ```ts
 * fromDrops('1000000') // '1.000000'
 * fromDrops('1000')    // '0.001000'
 * ```
 */
export function fromDrops(drops: string): string {
  const bi = BigInt(drops)
  if (bi < 0n) {
    return `-${fromDrops((-bi).toString())}`
  }
  const whole = (bi / 1_000_000n).toString()
  const remainder = (bi % 1_000_000n).toString().padStart(6, '0')
  return `${whole}.${remainder}`
}
