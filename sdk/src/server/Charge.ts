import { Method, Receipt, type Store } from 'mppx'
import { Client, decode, hashes } from 'xrpl'
import { XRPL_RPC_URLS } from '../constants.js'
import { fromTecResult, replayDetected, verificationFailed } from '../errors.js'
import * as Methods from '../Methods.js'
import type { ChargeServerConfig, XrplCurrency } from '../types.js'
import { isIOU, isMPT, parseCurrency, serializeCurrency } from '../utils/currency.js'
import { classicAddressFromDID } from '../utils/did.js'
import { assertTxExpiresWithinChallenge, readCurrentLedgerIndex } from '../utils/ledger-time.js'
import { ensureMPTHolding } from '../utils/mpt.js'
import { ensureTrustline } from '../utils/trustline.js'
import { Wallet } from '../utils/wallet.js'

/** Default max challenge age: 5 minutes. */
const DEFAULT_MAX_CHALLENGE_AGE_MS = 5 * 60 * 1000

/** Default max credential size: 64KB. */
const DEFAULT_MAX_CREDENTIAL_SIZE = 64 * 1024

/** tfPartialPayment flag -- partial payments can deliver less than Amount. */
const TF_PARTIAL_PAYMENT = 0x00020000

/**
 * Creates an XRPL charge method for use on the **server**.
 *
 * Verifies Payment transactions -- either by:
 * - **pull**: deserializing a signed blob, validating it, then submitting
 * - **push**: looking up a tx hash on-chain and verifying
 *
 * @example
 * ```ts
 * import { Mppx, Store } from 'mppx/server'
 * import { xrpl } from 'xrpl-mpp-sdk/server'
 *
 * const mppx = Mppx.create({
 *   methods: [
 *     xrpl.charge({
 *       recipient: 'rN7bRFgBrNZKoY2uu015bdjah11UbRZY',
 *       network: 'testnet',
 *     }),
 *   ],
 * })
 * ```
 */
export function charge(parameters: charge.Parameters) {
  const {
    recipient,
    currency,
    autoTrustline = false,
    autoTrustlineLimit,
    autoMPTAuthorize = false,
    wallet: walletInput,
    seed,
    network = 'testnet',
    rpcUrl: customRpcUrl,
    store,
    requireStore = true,
    maxChallengeAge = DEFAULT_MAX_CHALLENGE_AGE_MS,
    maxCredentialSize = DEFAULT_MAX_CREDENTIAL_SIZE,
    pollTimeout = 60_000,
    pollInterval = 1_000,
  } = parameters

  const recipientWallet: Wallet | undefined =
    walletInput ?? (seed ? Wallet.fromSeed(seed) : undefined)

  if ((autoTrustline || autoMPTAuthorize) && !recipientWallet) {
    throw new Error(
      '[xrpl-mpp-sdk] wallet (or seed) is required when autoTrustline or autoMPTAuthorize is enabled. ' +
        'The server needs to sign TrustSet/MPTokenAuthorize transactions for the recipient account.',
    )
  }

  if (recipientWallet && recipientWallet.address !== recipient) {
    throw new Error(
      `[xrpl-mpp-sdk] recipient wallet does not match recipient address. ` +
        `Wallet derives ${recipientWallet.address}, but recipient is ${recipient}.`,
    )
  }

  if (!store && requireStore) {
    throw new Error(
      '[xrpl-mpp-sdk] store is required for replay protection. ' +
        'Pass requireStore: false to explicitly disable replay protection.',
    )
  }

  const rpcUrl = customRpcUrl ?? XRPL_RPC_URLS[network]
  const currencyStr = currency ? serializeCurrency(currency) : 'XRP'

  // Auto-setup runs at most once per process: trustline / MPT auth on the
  // recipient is created lazily on first verify rather than at boot, so a
  // restart with no traffic doesn't burn a TrustSet fee. For end-to-end
  // IOU charge against a fresh recipient, the path resolver on the client
  // requires the trustline to exist before signing -- in that case the
  // server should call {@link prepareRecipient} eagerly at boot instead
  // of relying on this lazy setup.
  let recipientSetupDone = false
  async function ensureRecipientSetup(client: Client): Promise<void> {
    if (recipientSetupDone) return
    await runRecipientSetup(client, {
      currency,
      recipientWallet,
      autoTrustline,
      autoTrustlineLimit,
      autoMPTAuthorize,
    })
    recipientSetupDone = true
  }

  // Serialise verify calls so concurrent credentials can't race the store's
  // get/put on the same challenge id or tx hash.
  let verifyLock: Promise<unknown> = Promise.resolve()

  return Method.toServer(Methods.charge, {
    defaults: {
      currency: currencyStr,
      recipient,
    },
    request({ request }) {
      return {
        ...request,
        methodDetails: {
          ...request.methodDetails,
          reference: crypto.randomUUID(),
          network,
        },
      }
    },
    async verify({ credential }) {
      const result = await new Promise<Receipt.Receipt>((resolve, reject) => {
        verifyLock = verifyLock.then(
          () => doVerify(credential).then(resolve, reject),
          () => doVerify(credential).then(resolve, reject),
        )
      })
      return result
    },
  })

  async function doVerify(credential: any): Promise<Receipt.Receipt> {
    if (maxCredentialSize > 0) {
      const size = JSON.stringify(credential).length
      if (size > maxCredentialSize) {
        throw verificationFailed(
          'SUBMISSION_FAILED',
          `Credential too large (${size} bytes, max ${maxCredentialSize})`,
        )
      }
    }

    const { challenge } = credential
    const { request: challengeRequest } = challenge

    if (maxChallengeAge > 0 && challenge.createdAt) {
      const age = Date.now() - new Date(challenge.createdAt).getTime()
      if (age > maxChallengeAge) {
        throw verificationFailed(
          'SUBMISSION_FAILED',
          `Challenge expired (age: ${Math.round(age / 1000)}s, max: ${Math.round(maxChallengeAge / 1000)}s)`,
        )
      }
    }

    if (store) {
      const challengeKey = `xrpl:challenge:${challenge.id}`
      const existing = await store.get(challengeKey)
      if (existing) {
        throw replayDetected(challenge.id)
      }
      await store.put(challengeKey, { usedAt: new Date().toISOString() })
    }

    const challengeId = challenge.id as string | undefined
    const expectedAmount = challengeRequest.amount
    const expectedRecipient = challengeRequest.recipient
    const expectedCurrency = parseCurrency(challengeRequest.currency)
    const expectedInvoiceId = challengeRequest.methodDetails?.invoiceId as string | undefined
    const expectedDestinationTag = challengeRequest.methodDetails?.destinationTag as
      | number
      | undefined
    const expectedSourceTag = challengeRequest.methodDetails?.sourceTag as number | undefined
    // Bind the credential to its DID-encoded sender. Without this, an attacker can
    // submit a third party's hash (push) or third party's signed blob (pull) as
    // their own credential.
    const expectedSender = classicAddressFromDID(credential.source)
    const payload = credential.payload

    // Pull mode: decode and validate the blob *before* connecting to the
    // network so a tampered or third-party-signed credential is rejected
    // without holding an open WebSocket.
    let preDecodedTx: any | undefined
    let preDerivedTxHash: string | undefined
    if (payload.type === 'transaction') {
      preDecodedTx = decode(payload.blob) as any
      if (preDecodedTx.TransactionType !== 'Payment') {
        throw verificationFailed(
          'SUBMISSION_FAILED',
          `Expected Payment transaction, got ${preDecodedTx.TransactionType}`,
        )
      }
      validatePaymentFields(
        preDecodedTx,
        expectedAmount,
        expectedRecipient,
        expectedCurrency,
        expectedSender,
        expectedInvoiceId,
        expectedDestinationTag,
        expectedSourceTag,
      )
      preDerivedTxHash = hashes.hashSignedTx(payload.blob)
      if (store && preDerivedTxHash) {
        const hashKey = `xrpl:tx:${preDerivedTxHash}`
        const hashUsed = await store.get(hashKey)
        if (hashUsed) {
          throw replayDetected(preDerivedTxHash)
        }
        await store.put(hashKey, { status: 'pending', startedAt: Date.now() })
      }
    }

    const challengeExpires = (challenge as { expires?: string }).expires

    const client = new Client(rpcUrl)
    await client.connect()

    try {
      await ensureRecipientSetup(client)

      // Pull mode: reject blobs whose LastLedgerSequence would let them
      // land past challenge.expires *before* spending a submit. Push mode
      // does the same check after fetching the validated tx in verifyPush.
      if (preDecodedTx && challengeExpires) {
        await assertChallengeExpiryRespected(client, preDecodedTx, challengeExpires)
      }

      switch (payload.type) {
        case 'hash': {
          return await verifyPush(
            client,
            payload.hash,
            expectedAmount,
            expectedRecipient,
            expectedCurrency,
            expectedSender,
            store,
            expectedInvoiceId,
            expectedDestinationTag,
            expectedSourceTag,
            challengeId,
            challengeExpires,
          )
        }
        case 'transaction': {
          return await verifyPull(
            client,
            payload.blob,
            preDerivedTxHash,
            store,
            pollTimeout,
            pollInterval,
            challengeId,
          )
        }
        default:
          throw verificationFailed(
            'SUBMISSION_FAILED',
            `Unsupported credential type: ${(payload as { type: string }).type}`,
          )
      }
    } finally {
      await client.disconnect()
    }
  }
}

/**
 * Run the LastLedgerSequence vs `challenge.expires` check, wrapping any
 * failure into a typed `VerificationFailedError` (`SUBMISSION_FAILED`).
 *
 * No-op when `tx.LastLedgerSequence` is missing -- the field is
 * technically optional; xrpl.js's autofill always sets it but a
 * hand-crafted tx might not.
 */
async function assertChallengeExpiryRespected(
  client: Client,
  tx: { LastLedgerSequence?: number },
  expiresIso: string,
): Promise<void> {
  const txLLS = tx.LastLedgerSequence
  if (typeof txLLS !== 'number') return
  const currentLedgerIndex = await readCurrentLedgerIndex(client)
  try {
    assertTxExpiresWithinChallenge({
      txLastLedgerSequence: txLLS,
      currentLedgerIndex,
      expiresIso,
    })
  } catch (err: any) {
    const reason =
      typeof err?.message === 'string'
        ? err.message
        : 'LastLedgerSequence vs challenge expiry check failed'
    // Strip the `[CODE] ` prefix the helper adds so verificationFailed's
    // own prefix is not duplicated.
    const detail = reason.replace(/^\[[^\]]+\]\s*/, '')
    throw verificationFailed('SUBMISSION_FAILED', detail)
  }
}

/**
 * Verify a push-mode credential (client already submitted, we have the hash).
 */
async function verifyPush(
  client: Client,
  txHash: string,
  expectedAmount: string,
  expectedRecipient: string,
  expectedCurrency: XrplCurrency,
  expectedSender: string,
  store: Store.Store | undefined,
  expectedInvoiceId?: string,
  expectedDestinationTag?: number,
  expectedSourceTag?: number,
  challengeId?: string,
  expiresIso?: string,
): Promise<Receipt.Receipt> {
  // Claim the tx hash before verification to close the TOCTOU window: in
  // distributed deployments two instances could otherwise both pass the
  // get-check before either reaches put.
  if (store) {
    const hashKey = `xrpl:tx:${txHash}`
    const hashUsed = await store.get(hashKey)
    if (hashUsed) {
      throw replayDetected(txHash)
    }
    await store.put(hashKey, { status: 'pending', startedAt: Date.now() })
  }

  const txResponse = await client.request({
    command: 'tx',
    transaction: txHash,
  })

  const result = txResponse.result as any
  // xrpl.js v4 nests the transaction fields under tx_json; older shapes flatten.
  const tx = result.tx_json ?? result
  const meta = result.meta ?? result.metaData ?? tx.meta ?? tx.metaData

  if (!meta || meta.TransactionResult !== 'tesSUCCESS') {
    const tecResult = meta?.TransactionResult ?? 'unknown'
    throw fromTecResult(tecResult, `Transaction ${txHash} did not succeed`)
  }

  if (expiresIso) {
    await assertChallengeExpiryRespected(client, tx, expiresIso)
  }

  validatePaymentFields(
    tx,
    expectedAmount,
    expectedRecipient,
    expectedCurrency,
    expectedSender,
    expectedInvoiceId,
    expectedDestinationTag,
    expectedSourceTag,
    meta,
  )

  if (store) {
    await store.put(`xrpl:tx:${txHash}`, { status: 'confirmed', usedAt: new Date().toISOString() })
  }

  return Receipt.from({
    method: 'xrpl',
    reference: txHash,
    ...(challengeId ? { externalId: challengeId } : {}),
    status: 'success',
    timestamp: new Date().toISOString(),
  })
}

/**
 * Verify a pull-mode credential (we have the signed blob, need to submit).
 */
async function verifyPull(
  client: Client,
  blob: string,
  txHash: string | undefined,
  store: Store.Store | undefined,
  pollTimeout: number,
  pollInterval: number,
  challengeId?: string,
): Promise<Receipt.Receipt> {
  // Field validation, hash derivation, and replay claim already happened in
  // doVerify() before we connected.
  const submitResult = await client.submit(blob)
  const engineResult = submitResult.result.engine_result

  if (engineResult !== 'tesSUCCESS' && engineResult !== 'terQUEUED') {
    throw fromTecResult(engineResult, `Transaction submission failed: ${engineResult}`)
  }

  if (txHash) {
    let validated = false
    const deadline = Date.now() + pollTimeout

    while (Date.now() < deadline) {
      try {
        const txResponse = await client.request({
          command: 'tx',
          transaction: txHash,
        })
        const meta = (txResponse.result as any).meta ?? (txResponse.result as any).metaData
        if (meta?.TransactionResult === 'tesSUCCESS') {
          validated = true
          break
        }
        if (meta?.TransactionResult && meta.TransactionResult !== 'tesSUCCESS') {
          throw fromTecResult(meta.TransactionResult, 'Transaction failed on-chain')
        }
      } catch (err: any) {
        // txnNotFound: tx hasn't been validated yet, keep polling. Other errors propagate.
        if (err?.data?.error !== 'txnNotFound') {
          throw err
        }
      }
      await new Promise((r) => setTimeout(r, pollInterval))
    }

    if (!validated) {
      throw verificationFailed(
        'SUBMISSION_FAILED',
        `Transaction not validated within ${pollTimeout}ms`,
      )
    }

    if (store) {
      await store.put(`xrpl:tx:${txHash}`, {
        status: 'confirmed',
        usedAt: new Date().toISOString(),
      })
    }

    return Receipt.from({
      method: 'xrpl',
      reference: txHash,
      ...(challengeId ? { externalId: challengeId } : {}),
      status: 'success',
      timestamp: new Date().toISOString(),
    })
  }

  throw verificationFailed('SUBMISSION_FAILED', 'No transaction hash returned from submit')
}

/**
 * Reject transactions with the tfPartialPayment flag.
 * Partial payments can deliver less than Amount -- an attacker can pay
 * a fraction of the requested amount while passing amount validation.
 */
function rejectPartialPayment(tx: any): void {
  const flags = tx.Flags ?? 0
  if ((flags & TF_PARTIAL_PAYMENT) !== 0) {
    throw verificationFailed(
      'SUBMISSION_FAILED',
      'Partial payment flag (tfPartialPayment) is not permitted',
    )
  }
}

/** Validate Payment tx fields (Account, Destination, Amount, Currency, InvoiceID, tags) against challenge. */
function validatePaymentFields(
  tx: any,
  expectedAmount: string,
  expectedRecipient: string,
  expectedCurrency: XrplCurrency,
  expectedSender: string,
  expectedInvoiceId?: string,
  expectedDestinationTag?: number,
  expectedSourceTag?: number,
  meta?: any,
): void {
  rejectPartialPayment(tx)

  // Bind the on-chain payer to the credential's DID source. This blocks
  // hash-theft (push) and third-party-blob replay (pull).
  if (tx.Account !== expectedSender) {
    throw verificationFailed(
      'SOURCE_MISMATCH',
      `Expected payer ${expectedSender} (from credential source), got ${tx.Account}`,
    )
  }

  if (expectedInvoiceId && tx.InvoiceID !== expectedInvoiceId) {
    throw verificationFailed(
      'SUBMISSION_FAILED',
      `InvoiceID mismatch: expected ${expectedInvoiceId}, got ${tx.InvoiceID ?? 'none'}`,
    )
  }

  if (expectedDestinationTag !== undefined && tx.DestinationTag !== expectedDestinationTag) {
    throw verificationFailed(
      'SUBMISSION_FAILED',
      `DestinationTag mismatch: expected ${expectedDestinationTag}, got ${tx.DestinationTag ?? 'none'}`,
    )
  }

  if (expectedSourceTag !== undefined && tx.SourceTag !== expectedSourceTag) {
    throw verificationFailed(
      'SUBMISSION_FAILED',
      `SourceTag mismatch: expected ${expectedSourceTag}, got ${tx.SourceTag ?? 'none'}`,
    )
  }

  const destination = tx.Destination
  if (destination !== expectedRecipient) {
    throw verificationFailed(
      'RECIPIENT_MISMATCH',
      `Expected recipient ${expectedRecipient}, got ${destination}`,
    )
  }

  // Use delivered_amount from meta when available (push mode / validated tx).
  // delivered_amount reflects the actual amount received; tx.Amount is the maximum.
  const txAmount = meta?.delivered_amount ?? tx.Amount ?? tx.DeliverMax

  if (expectedCurrency === 'XRP') {
    if (typeof txAmount !== 'string') {
      throw verificationFailed('AMOUNT_MISMATCH', 'Expected XRP (drops string), got object')
    }
    if (txAmount !== expectedAmount) {
      throw verificationFailed(
        'AMOUNT_MISMATCH',
        `Expected ${expectedAmount} drops, got ${txAmount}`,
      )
    }
  } else if ('currency' in expectedCurrency) {
    if (typeof txAmount !== 'object') {
      throw verificationFailed('AMOUNT_MISMATCH', 'Expected IOU amount object, got string')
    }
    if (txAmount.currency !== expectedCurrency.currency) {
      throw verificationFailed(
        'AMOUNT_MISMATCH',
        `Expected currency ${expectedCurrency.currency}, got ${txAmount.currency}`,
      )
    }
    if (txAmount.issuer !== expectedCurrency.issuer) {
      throw verificationFailed(
        'AMOUNT_MISMATCH',
        `Expected issuer ${expectedCurrency.issuer}, got ${txAmount.issuer}`,
      )
    }
    if (txAmount.value !== expectedAmount) {
      throw verificationFailed(
        'AMOUNT_MISMATCH',
        `Expected amount ${expectedAmount}, got ${txAmount.value}`,
      )
    }
  } else if ('mpt_issuance_id' in expectedCurrency) {
    if (typeof txAmount !== 'object') {
      throw verificationFailed('AMOUNT_MISMATCH', 'Expected MPT amount object, got string')
    }
    if (txAmount.mpt_issuance_id !== expectedCurrency.mpt_issuance_id) {
      throw verificationFailed(
        'AMOUNT_MISMATCH',
        `Expected MPT ${expectedCurrency.mpt_issuance_id}, got ${txAmount.mpt_issuance_id}`,
      )
    }
    if (txAmount.value !== expectedAmount) {
      throw verificationFailed(
        'AMOUNT_MISMATCH',
        `Expected amount ${expectedAmount}, got ${txAmount.value}`,
      )
    }
  }
}

export declare namespace charge {
  export type Parameters = ChargeServerConfig & {
    /** Store for replay protection. */
    store?: Store.Store
    /** Require a store for replay protection. @default true */
    requireStore?: boolean
    /** Max challenge age in milliseconds. 0 disables. @default 300000 (5 min) */
    maxChallengeAge?: number
    /** Max credential size in bytes. 0 disables. @default 65536 (64KB) */
    maxCredentialSize?: number
    /** Polling timeout for tx validation in milliseconds. @default 60000 */
    pollTimeout?: number
    /** Polling interval for tx validation in milliseconds. @default 1000 */
    pollInterval?: number
  }
}

/**
 * Run the recipient-side trustline / MPT-auth setup once. Shared between
 * the lazy path inside `charge()` and the eager `prepareRecipient()`.
 */
async function runRecipientSetup(
  client: Client,
  config: {
    currency?: XrplCurrency
    recipientWallet?: Wallet
    autoTrustline: boolean
    autoTrustlineLimit?: string
    autoMPTAuthorize: boolean
  },
): Promise<void> {
  const { currency, recipientWallet, autoTrustline, autoTrustlineLimit, autoMPTAuthorize } = config
  if (!currency || !recipientWallet) return
  const xrplWallet = recipientWallet._xrplWallet

  if (isIOU(currency) && autoTrustline) {
    await ensureTrustline({
      client,
      wallet: xrplWallet,
      currency,
      autoTrustline: true,
      trustlineLimit: autoTrustlineLimit,
    })
  }

  if (isMPT(currency) && autoMPTAuthorize) {
    await ensureMPTHolding({
      client,
      wallet: xrplWallet,
      mpt: currency,
      autoMPTAuthorize: true,
    })
  }
}

/**
 * Eagerly run the recipient-side `TrustSet` (when {@link charge.Parameters.autoTrustline}
 * is on and the currency is an IOU) and `MPTokenAuthorize` (when
 * {@link charge.Parameters.autoMPTAuthorize} is on and the currency is
 * an MPT) for the recipient wallet.
 *
 * Why call this instead of relying on lazy setup inside `verify()`?
 *
 * For IOU charges, the client-side path resolver requires the recipient's
 * trustline to *already* exist in order to find a viable
 * `ripple_path_find` alternative or to fall through to the direct-trustline
 * shortcut. If the trustline only appears in `verify()` (after the client
 * has already signed), the client throws `PAYMENT_PATH_FAILED` before the
 * server ever sees the credential. Calling `prepareRecipient()` once at
 * boot (or before issuing the first 402 in this currency) fixes that
 * chicken-and-egg.
 *
 * For MPT charges, lazy setup works end-to-end (MPTs do not go through
 * the path resolver), but eager setup is still useful to fail fast at
 * boot if the wallet cannot cover the owner reserve increment.
 *
 * Idempotent: returns immediately on a second call once the trustline
 * or MPT holding is in place. Opens and closes its own xrpl.Client.
 *
 * Throws when no `wallet` (or `seed`) is configured -- the function needs
 * to sign on behalf of the recipient. Returns silently when the configured
 * `currency` is XRP (nothing to set up) or when both auto-setup flags
 * are off.
 *
 * @example
 * ```ts
 * import { charge, prepareRecipient } from 'xrpl-mpp-sdk/server'
 *
 * const params = {
 *   recipient: recipient.address,
 *   wallet: recipient,
 *   currency: { currency: 'USD', issuer: 'rIssuer...' },
 *   autoTrustline: true,
 *   network: 'testnet',
 *   store: Store.memory(),
 * } satisfies charge.Parameters
 *
 * await prepareRecipient(params)   // creates the trustline once at boot
 * const method = charge(params)    // method is now ready to verify
 * ```
 */
export async function prepareRecipient(parameters: charge.Parameters): Promise<void> {
  const {
    recipient,
    currency,
    autoTrustline = false,
    autoTrustlineLimit,
    autoMPTAuthorize = false,
    wallet: walletInput,
    seed,
    network = 'testnet',
    rpcUrl: customRpcUrl,
  } = parameters

  const recipientWallet: Wallet | undefined =
    walletInput ?? (seed ? Wallet.fromSeed(seed) : undefined)

  if (!recipientWallet) {
    throw new Error(
      '[xrpl-mpp-sdk] wallet (or seed) is required to call prepareRecipient. ' +
        'The function signs TrustSet / MPTokenAuthorize on the recipient account.',
    )
  }

  if (recipientWallet.address !== recipient) {
    throw new Error(
      `[xrpl-mpp-sdk] recipient wallet does not match recipient address. ` +
        `Wallet derives ${recipientWallet.address}, but recipient is ${recipient}.`,
    )
  }

  if (!currency || (!autoTrustline && !autoMPTAuthorize)) return

  const rpcUrl = customRpcUrl ?? XRPL_RPC_URLS[network]
  const client = new Client(rpcUrl)
  await client.connect()
  try {
    await runRecipientSetup(client, {
      currency,
      recipientWallet,
      autoTrustline,
      autoTrustlineLimit,
      autoMPTAuthorize,
    })
  } finally {
    await client.disconnect()
  }
}
