import { Method } from 'mppx'
import { z } from 'zod/mini'

/**
 * XRPL session intent -- off-chain PayChannel claims (XRP-only, both ed25519
 * and secp256k1).
 *
 * The wire `intent` is the canonical MPP `session` intent (mpp.dev: pay-as-you-go
 * over a payment channel). The underlying mechanism is an XRPL Payment Channel,
 * so the SDK keeps the "channel" name for its own API, exports, and helpers.
 * The server/client wrappers register `alias: 'channel'` so credentials issued
 * against the pre-`session` wire intent still route and verify.
 */
export const channel = Method.from({
  name: 'xrpl',
  intent: 'session',
  schema: {
    credential: {
      payload: z.union([
        z.object({
          action: z.literal('open'),
          /** Signed PaymentChannelCreate tx blob. */
          transaction: z.string(),
          /** Initial cumulative claim amount (drops). */
          amount: z.string().check(z.regex(/^\d+$/)),
          /** Hex-encoded claim signature for the initial amount. */
          signature: z.string().check(z.regex(/^[0-9a-fA-F]+$/)),
        }),
        z.object({
          action: z.literal('voucher'),
          channelId: z.string(),
          amount: z.string().check(z.regex(/^\d+$/)),
          signature: z.string().check(z.regex(/^[0-9a-fA-F]+$/)),
        }),
        z.object({
          action: z.literal('close'),
          channelId: z.string(),
          amount: z.string().check(z.regex(/^\d+$/)),
          signature: z.string().check(z.regex(/^[0-9a-fA-F]+$/)),
        }),
      ]),
    },
    request: z.object({
      /** Incremental payment amount in drops. */
      amount: z.string(),
      /**
       * Currency identifier. XRPL PayChannels are XRP-only, so this is always
       * `"XRP"`. Present because the canonical MPP `session` request carries a
       * `currency`; optional here to stay backward-compatible with challenges
       * issued before the field existed.
       */
      currency: z.optional(z.string()),
      /** PayChannel ID (64 hex chars). */
      channelId: z.string(),
      /** Recipient XRPL classic address (r...). */
      recipient: z.string(),
      /** Optional human-readable description. */
      description: z.optional(z.string()),
      /** Merchant-provided reconciliation ID. */
      externalId: z.optional(z.string()),
      /** Method-specific details injected by the server. */
      methodDetails: z.optional(
        z.object({
          /** Server-generated unique tracking ID. */
          reference: z.optional(z.string()),
          /** XRPL network identifier. */
          network: z.optional(z.string()),
          /** Cumulative amount already committed up to this point (drops). */
          cumulativeAmount: z.optional(z.string()),
        }),
      ),
    }),
  },
})
