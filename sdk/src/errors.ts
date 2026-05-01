import { Errors } from 'mppx'

export const TEC_RESULT_MAP: Record<string, string> = {
  // -- Payment failures
  tecPATH_DRY: 'PAYMENT_PATH_FAILED',
  // tecPATH_PARTIAL means a path exists but liquidity is insufficient -- this
  // is a path/liquidity issue, not a sender-balance issue.
  tecPATH_PARTIAL: 'PAYMENT_PATH_FAILED',
  tecUNFUNDED_PAYMENT: 'INSUFFICIENT_BALANCE',
  tecNO_DST: 'RECIPIENT_NOT_FOUND',
  // -- Trustline / authorisation
  tecNO_AUTH: 'TRUSTLINE_NOT_AUTHORIZED',
  tecNO_LINE: 'MISSING_TRUSTLINE',
  tecNO_LINE_INSUF_RESERVE: 'INSUFFICIENT_RESERVE',
  tecNO_LINE_REDUNDANT: 'MISSING_TRUSTLINE',
  tecFROZEN: 'TRUSTLINE_FROZEN',
  // -- Reserve / fee
  tecINSUFFICIENT_RESERVE: 'INSUFFICIENT_RESERVE',
  tecINSUFF_FEE: 'INSUFFICIENT_FEE',
  terINSUF_FEE_B: 'INSUFFICIENT_FEE',
  // -- Sequence / submission
  tefPAST_SEQ: 'SUBMISSION_FAILED',
  tefALREADY: 'SUBMISSION_FAILED',
  tefBAD_AUTH: 'INVALID_SIGNATURE',
  tefMASTER_DISABLED: 'INVALID_SIGNATURE',
  // -- Validation
  temBAD_AMOUNT: 'INVALID_AMOUNT',
  // tecNO_PERMISSION is the MPT-era rejection: holder not authorised by issuer
  // when the issuance has lsfMPTRequireAuth.
  tecNO_PERMISSION: 'MPT_NOT_AUTHORIZED',
}

export type XrplErrorCode =
  | 'PAYMENT_PATH_FAILED'
  | 'INSUFFICIENT_BALANCE'
  | 'INSUFFICIENT_FEE'
  | 'INSUFFICIENT_RESERVE'
  | 'RECIPIENT_NOT_FOUND'
  | 'TRUSTLINE_NOT_AUTHORIZED'
  | 'TRUSTLINE_REQUIRES_AUTH'
  | 'TRUSTLINE_FROZEN'
  | 'MISSING_TRUSTLINE'
  | 'ISSUER_GLOBAL_FROZEN'
  | 'INVALID_AMOUNT'
  | 'CHANNEL_EXPIRED'
  | 'CHANNEL_NOT_FOUND'
  | 'CHANNEL_EXHAUSTED'
  | 'INVALID_SIGNATURE'
  | 'REPLAY_DETECTED'
  | 'AMOUNT_MISMATCH'
  | 'RECIPIENT_MISMATCH'
  | 'SOURCE_MISMATCH'
  | 'SUBMISSION_FAILED'
  | 'MPT_NOT_AUTHORIZED'

export function mapTecResult(tecResult: string): XrplErrorCode | undefined {
  return TEC_RESULT_MAP[tecResult] as XrplErrorCode | undefined
}

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

export function channelExhausted(
  channelId: string,
  cumulative: bigint,
  available: bigint,
): Errors.AmountExceedsDepositError {
  return new Errors.AmountExceedsDepositError({
    reason: `[CHANNEL_EXHAUSTED] Cumulative ${cumulative} drops on channel ${channelId} exceeds available balance ${available} drops -- top up via PaymentChannelFund or reset cumulative.`,
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
