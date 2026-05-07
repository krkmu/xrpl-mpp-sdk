/**
 * Payment intent schema and pricing.
 *
 * The "intent" is the JSON payload the client POSTs to /agent/run before
 * payment. The server validates it, computes a price, and only then issues
 * the 402 challenge. Because the price is bound to the challenge (which is
 * itself signed by mppx), the client can't substitute a cheaper intent
 * after seeing the challenge.
 */
import { z } from 'zod'

export const SUPPORTED_MODELS = ['mock-small', 'mock-large'] as const
export type Model = (typeof SUPPORTED_MODELS)[number]

export const PaymentIntent = z.object({
  prompt: z.string().min(1).max(8_000),
  model: z.enum(SUPPORTED_MODELS).default('mock-small'),
  maxTokens: z.number().int().positive().max(10_000).default(256),
  metadata: z.record(z.string(), z.string()).optional(),
})

export type PaymentIntent = z.infer<typeof PaymentIntent>

/** Per-model multiplier on the base price (in basis points; 10000 = 1x). */
const MODEL_MULTIPLIER_BPS: Record<Model, bigint> = {
  'mock-small': 10_000n,
  'mock-large': 50_000n,
}

/**
 * Quote the price (in drops) for an intent.
 *
 * Price = ceil( basePricePer1k * (maxTokens / 1000) * modelMultiplier )
 *
 * Always rounds up so a 1-token request still costs at least 1 drop.
 */
export function priceOf(intent: PaymentIntent, basePricePer1kDrops: bigint): bigint {
  const multiplier = MODEL_MULTIPLIER_BPS[intent.model]
  const numerator = basePricePer1kDrops * BigInt(intent.maxTokens) * multiplier
  const denominator = 1000n * 10_000n
  const price = (numerator + denominator - 1n) / denominator
  return price < 1n ? 1n : price
}
