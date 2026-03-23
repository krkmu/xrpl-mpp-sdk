import { Errors } from 'mppx'

// -- XRPL tecResult to SDK error code mapping --

export const TEC_RESULT_MAP: Record<string, string> = {
  tecPATH_DRY: 'PAYMENT_PATH_FAILED',
  tecUNFUNDED_PAYMENT: 'INSUFFICIENT_BALANCE',
  tecNO_DST: 'RECIPIENT_NOT_FOUND',
  tecNO_AUTH: 'TRUSTLINE_NOT_AUTHORIZED',
  tecNO_LINE: 'MISSING_TRUSTLINE',
  temBAD_AMOUNT: 'INVALID_AMOUNT',
}

// -- XRPL-specific error detail codes --

export type XrplErrorCode =
  | 'PAYMENT_PATH_FAILED'
  | 'INSUFFICIENT_BALANCE'
  | 'RECIPIENT_NOT_FOUND'
  | 'TRUSTLINE_NOT_AUTHORIZED'
  | 'MISSING_TRUSTLINE'
  | 'INVALID_AMOUNT'
  | 'CHANNEL_EXPIRED'
  | 'CHANNEL_NOT_FOUND'
  | 'INVALID_SIGNATURE'
  | 'REPLAY_DETECTED'
  | 'AMOUNT_MISMATCH'
  | 'RECIPIENT_MISMATCH'
  | 'SUBMISSION_FAILED'
  | 'MPT_NOT_AUTHORIZED'

// -- Map tecResult strings to XRPL error codes --

export function mapTecResult(tecResult: string): XrplErrorCode | undefined {
  return TEC_RESULT_MAP[tecResult] as XrplErrorCode | undefined
}

// -- Convenience error constructors wrapping mppx error types --
// These add XRPL-specific context inside the standard MPP error structure.

export function verificationFailed(
  code: XrplErrorCode,
  detail: string,
  tecResult?: string,
): Errors.VerificationFailedError {
  const parts = [`[${code}] ${detail}`]
  if (tecResult) parts.push(`(tecResult: ${tecResult})`)
  return new Errors.VerificationFailedError({ reason: parts.join(' ') })
}

export function insufficientBalance(
  detail: string,
  tecResult?: string,
): Errors.InsufficientBalanceError {
  const reason = tecResult ? `[INSUFFICIENT_BALANCE] ${detail} (tecResult: ${tecResult})` : detail
  return new Errors.InsufficientBalanceError({ reason })
}

export function invalidSignature(detail: string): Errors.InvalidSignatureError {
  return new Errors.InvalidSignatureError({ reason: `[INVALID_SIGNATURE] ${detail}` })
}

export function channelNotFound(channelId: string): Errors.ChannelNotFoundError {
  return new Errors.ChannelNotFoundError({
    reason: `[CHANNEL_NOT_FOUND] Channel ${channelId} does not exist`,
  })
}

export function channelClosed(channelId: string): Errors.ChannelClosedError {
  return new Errors.ChannelClosedError({
    reason: `[CHANNEL_EXPIRED] Channel ${channelId} is expired or closed`,
  })
}

export function malformedCredential(detail: string): Errors.MalformedCredentialError {
  return new Errors.MalformedCredentialError({ reason: detail })
}

export function replayDetected(identifier: string): Errors.VerificationFailedError {
  return new Errors.VerificationFailedError({
    reason: `[REPLAY_DETECTED] Credential already used: ${identifier}`,
  })
}

/** Map a raw XRPL transaction engine result to the appropriate MPP error. */
export function fromTecResult(
  tecResult: string,
  detail?: string,
): Errors.VerificationFailedError | Errors.InsufficientBalanceError {
  const code = mapTecResult(tecResult)
  const message = detail ?? `Transaction failed with ${tecResult}`

  if (code === 'INSUFFICIENT_BALANCE') {
    return insufficientBalance(message, tecResult)
  }

  return verificationFailed(code ?? 'SUBMISSION_FAILED', message, tecResult)
}
