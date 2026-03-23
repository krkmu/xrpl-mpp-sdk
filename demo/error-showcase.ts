import {
  channelClosed,
  fromTecResult,
  invalidSignature,
  replayDetected,
  verificationFailed,
} from '../sdk/src/errors.js'

let caseNum = 0
const total = 11

function header(name: string): void {
  caseNum++
  console.log(`\n[${caseNum}/${total}] ${name}`)
}

function showError(err: Error): void {
  const pe = err as any
  console.log(`  -> ERROR: ${pe.name ?? err.constructor.name} -- ${err.message}`)
  if (pe.type) console.log(`     Type: ${pe.type}`)
  if (pe.status) console.log(`     Status: ${pe.status}`)
}

function showSuccess(detail: string): void {
  console.log(`  -> SUCCESS: ${detail}`)
}

// -- XRP Errors --

header('INSUFFICIENT_BALANCE')
console.log('  -> Attempting payment with unfunded wallet...')
const err1 = fromTecResult('tecUNFUNDED_PAYMENT', 'Account balance too low for amount + reserve')
showError(err1)
console.log('  -> Fixing: funding wallet via testnet faucet...')
showSuccess('After funding, payment would succeed')

header('RECIPIENT_NOT_FOUND')
console.log('  -> Attempting payment to non-existent address...')
const err2 = verificationFailed(
  'RECIPIENT_NOT_FOUND',
  'Destination rNonExistent does not exist on ledger',
)
showError(err2)
console.log('  -> Fixing: creating the destination account...')
showSuccess('After creating account, payment would succeed')

header('INVALID_AMOUNT')
console.log('  -> Attempting to send 0 drops...')
const err3 = fromTecResult('temBAD_AMOUNT', 'Amount must be > 0')
showError(err3)
console.log('  -> Fixing: changing amount to 1000000 drops...')
showSuccess('Valid amount accepted')

// -- IOU Errors --

header('MISSING_TRUSTLINE')
console.log('  -> Attempting IOU payment without trustline...')
const err4 = verificationFailed('MISSING_TRUSTLINE', 'No trustline for USD from issuer rIssuer')
showError(err4)
console.log('  -> Fixing: setting autoTrustline: true...')
showSuccess('Trustline auto-created, payment would succeed')

header('TRUSTLINE_NOT_AUTHORIZED')
console.log('  -> Attempting IOU payment where issuer requires authorization...')
const err5 = fromTecResult('tecNO_AUTH', 'Issuer requires authorization for this trustline')
showError(err5)
console.log('  -> This requires issuer action -- cannot auto-fix')
console.log('  -> The issuer must submit a TrustSet with tfSetfAuth flag')

header('PAYMENT_PATH_FAILED')
console.log('  -> Attempting IOU payment with rippling disabled on issuer...')
const err6 = fromTecResult('tecPATH_DRY', 'Issuer does not have DefaultRipple enabled')
showError(err6)
console.log('  -> Root cause: issuer needs to set DefaultRipple flag')
console.log('  -> Issuer must submit AccountSet with asfDefaultRipple')

// -- MPT Errors --

header('MPT_NOT_AUTHORIZED')
console.log('  -> Attempting MPT payment without holding...')
const err7 = verificationFailed(
  'MPT_NOT_AUTHORIZED',
  'Account does not hold MPT 00000001A407AF5856CEFB...',
)
showError(err7)
console.log('  -> Fixing: setting autoMPTAuthorize: true...')
showSuccess('MPT holding auto-authorized, payment would succeed')

header('INVALID_AMOUNT (AssetScale)')
console.log('  -> Attempting MPT payment with too many decimals...')
const err8 = fromTecResult('temBAD_AMOUNT', 'Amount has more decimals than MPT AssetScale allows')
showError(err8)
console.log('  -> Fixing: rounding to correct precision...')
showSuccess('Valid precision accepted')

// -- Channel Errors --

header('INVALID_SIGNATURE (wrong signer)')
console.log('  -> Signing claim with wrong wallet...')
const err9 = invalidSignature('Claim signer does not match channel PublicKey')
showError(err9)
console.log('  -> Fixing: signing with correct wallet...')
showSuccess('Valid signature accepted')

header('REPLAY_DETECTED')
console.log('  -> Submitting same cumulative amount twice...')
const err10 = replayDetected('channelABC:500000')
showError(err10)
console.log('  -> Fixing: incrementing cumulative amount...')
showSuccess('Higher cumulative accepted')

header('CHANNEL_EXPIRED')
console.log('  -> Attempting claim on expired channel...')
const err11 = channelClosed('E'.repeat(64))
showError(err11)
console.log('  -> Channel is expired -- open a new channel')

console.log('\n--- All error cases demonstrated ---')
