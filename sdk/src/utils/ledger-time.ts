/**
 * Helpers that translate wall-clock challenge expiry into XRPL ledger
 * coordinates, and back. Used by both the client (to cap a transaction's
 * `LastLedgerSequence`) and the server (to reject blobs / validated txs
 * whose `LastLedgerSequence` would let them outlive the challenge).
 *
 * Why this matters: `mppx`'s `challenge.expires` is enforced at the MPP
 * layer (server compares wall-clock now vs `expires` at verify time),
 * but xrpl.js's default `autofill` sets `LastLedgerSequence ≈ current +
 * 4` (~16s). On a slow ledger or with retries, that window can outlive
 * a tight challenge -- giving an attacker who intercepts the signed
 * blob a replay opportunity past the logical expiry.
 */

import type { Client } from 'xrpl'

/** XRPL nominal ledger-close interval. Real intervals jitter around this. */
export const LEDGER_CLOSE_INTERVAL_MS = 4_000

/**
 * Slack added to server-side checks: a tx whose `LastLedgerSequence`
 * exceeds the cap by up to this many ledgers is still accepted, to
 * tolerate clock drift between client and server and the ±2s jitter
 * around the nominal ledger close interval.
 */
export const SERVER_SLACK_LEDGERS = 4

/** Read the current (in-progress) ledger index from the connected node. */
export async function readCurrentLedgerIndex(client: Client): Promise<number> {
  const r = await client.request({ command: 'ledger_current' } as any)
  const idx = (r.result as any).ledger_current_index
  if (typeof idx !== 'number' || !Number.isFinite(idx)) {
    throw new Error(
      '[SUBMISSION_FAILED] ledger_current did not return a valid ledger_current_index.',
    )
  }
  return idx
}

/**
 * Compute the maximum `LastLedgerSequence` value such that the
 * transaction is forced to expire at or before the given ISO-8601
 * challenge expiry, given the current (in-progress) ledger index.
 *
 * Throws `INVALID_AMOUNT` when `expiresIso` is unparseable, or
 * `SUBMISSION_FAILED` when the challenge is already expired or has
 * less than one ledger interval remaining (no room to land any tx
 * before expiry).
 */
export function lastLedgerSequenceFromExpires(params: {
  currentLedgerIndex: number
  expiresIso: string
  /** Override `Date.now()` -- useful for deterministic tests. */
  nowMs?: number
}): number {
  const { currentLedgerIndex, expiresIso } = params
  const now = params.nowMs ?? Date.now()
  const expiresMs = Date.parse(expiresIso)
  if (Number.isNaN(expiresMs)) {
    throw new Error(
      `[INVALID_AMOUNT] challenge.expires is not a valid ISO-8601 date: ${expiresIso}.`,
    )
  }
  const msUntilExpiry = expiresMs - now
  if (msUntilExpiry <= LEDGER_CLOSE_INTERVAL_MS) {
    throw new Error(
      `[SUBMISSION_FAILED] challenge.expires (${expiresIso}) leaves less than one ledger ` +
        `interval (~${LEDGER_CLOSE_INTERVAL_MS / 1000}s) -- no room to submit a transaction before expiry.`,
    )
  }
  // ceil so we land *at or before* expiry: a fractional remainder counts
  // as a full ledger we can wait for. Cap is current + how many ledger
  // intervals fit before expiry.
  return currentLedgerIndex + Math.ceil(msUntilExpiry / LEDGER_CLOSE_INTERVAL_MS)
}

/**
 * Server-side check: assert `txLastLedgerSequence` would not let the
 * transaction land past `challenge.expires` (plus a small ledger-jitter
 * slack). Returns void on success; throws a plain Error tagged
 * `SUBMISSION_FAILED` (callers wrap it into a typed
 * `VerificationFailedError`).
 *
 * No-op when the client did not embed a `LastLedgerSequence` -- the
 * field is technically optional on Payment, but xrpl.js's `autofill`
 * always sets it. Validating only when present keeps us robust to
 * the rare hand-crafted tx.
 */
export function assertTxExpiresWithinChallenge(params: {
  txLastLedgerSequence: number | undefined
  currentLedgerIndex: number
  expiresIso: string
  nowMs?: number
}): void {
  const { txLastLedgerSequence, currentLedgerIndex, expiresIso } = params
  if (txLastLedgerSequence === undefined) return
  const cap = lastLedgerSequenceFromExpires({
    currentLedgerIndex,
    expiresIso,
    ...(params.nowMs !== undefined ? { nowMs: params.nowMs } : {}),
  })
  const allowed = cap + SERVER_SLACK_LEDGERS
  if (txLastLedgerSequence > allowed) {
    throw new Error(
      `[SUBMISSION_FAILED] Transaction LastLedgerSequence (${txLastLedgerSequence}) exceeds the ` +
        `cap (${allowed}) derived from challenge.expires (${expiresIso}). The transaction ` +
        'would remain valid past the challenge expiry, which the server rejects to prevent ' +
        'late re-submission of intercepted blobs.',
    )
  }
}
