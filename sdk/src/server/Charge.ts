import { Method, Receipt, type Store } from 'mppx'
import { Client, decode, hashes, Wallet } from 'xrpl'
import { XRPL_RPC_URLS } from '../constants.js'
import { fromTecResult, replayDetected, verificationFailed } from '../errors.js'
import * as Methods from '../Methods.js'
import type { ChargeServerConfig, XrplCurrency } from '../types.js'
import { isIOU, isMPT, parseCurrency, serializeCurrency } from '../utils/currency.js'
import { ensureMPTHolding } from '../utils/mpt.js'
import { ensureTrustline } from '../utils/trustline.js'

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

  if ((autoTrustline || autoMPTAuthorize) && !seed) {
    throw new Error(
      '[xrpl-mpp-sdk] seed is required when autoTrustline or autoMPTAuthorize is enabled. ' +
        'The server needs to sign TrustSet/MPTokenAuthorize transactions for the recipient account.',
    )
  }

  if (seed) {
    const recipientWallet = Wallet.fromSeed(seed)
    if (recipientWallet.classicAddress !== recipient) {
      throw new Error(
        `[xrpl-mpp-sdk] seed does not match recipient. ` +
          `Seed derives ${recipientWallet.classicAddress}, but recipient is ${recipient}.`,
      )
    }
  }

  if (!store && requireStore) {
    throw new Error(
      '[xrpl-mpp-sdk] store is required for replay protection. ' +
        'Pass requireStore: false to explicitly disable replay protection.',
    )
  }

  const rpcUrl = customRpcUrl ?? XRPL_RPC_URLS[network]
  const currencyStr = currency ? serializeCurrency(currency) : 'XRP'

  // Run auto-setup for recipient account (trustline/MPT) on first verify
  let recipientSetupDone = false
  async function ensureRecipientSetup(client: Client): Promise<void> {
    if (recipientSetupDone || !currency) return
    const wallet = seed ? Wallet.fromSeed(seed) : undefined
    if (!wallet) return

    if (isIOU(currency) && autoTrustline) {
      await ensureTrustline({
        client,
        wallet,
        currency,
        autoTrustline: true,
        trustlineLimit: autoTrustlineLimit,
      })
    }

    if (isMPT(currency) && autoMPTAuthorize) {
      await ensureMPTHolding({
        client,
        wallet,
        mpt: currency,
        autoMPTAuthorize: true,
      })
    }

    recipientSetupDone = true
  }

  // Serialize verify operations to prevent concurrent race conditions
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
    // Check credential size before processing
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

    // Check challenge TTL
    if (maxChallengeAge > 0 && challenge.createdAt) {
      const age = Date.now() - new Date(challenge.createdAt).getTime()
      if (age > maxChallengeAge) {
        throw verificationFailed(
          'SUBMISSION_FAILED',
          `Challenge expired (age: ${Math.round(age / 1000)}s, max: ${Math.round(maxChallengeAge / 1000)}s)`,
        )
      }
    }

    // Check challenge replay
    if (store) {
      const challengeKey = `xrpl:challenge:${challenge.id}`
      const existing = await store.get(challengeKey)
      if (existing) {
        throw replayDetected(challenge.id)
      }
      await store.put(challengeKey, { usedAt: new Date().toISOString() })
    }

    const expectedAmount = challengeRequest.amount
    const expectedRecipient = challengeRequest.recipient
    const expectedCurrency = parseCurrency(challengeRequest.currency)
    const expectedInvoiceId = challengeRequest.methodDetails?.invoiceId as string | undefined
    const payload = credential.payload

    const client = new Client(rpcUrl)
    await client.connect()

    try {
      // Ensure recipient has trustline/MPT holding before verifying payment
      await ensureRecipientSetup(client)

      switch (payload.type) {
        case 'hash': {
          return await verifyPush(
            client,
            payload.hash,
            expectedAmount,
            expectedRecipient,
            expectedCurrency,
            store,
            expectedInvoiceId,
          )
        }
        case 'transaction': {
          return await verifyPull(
            client,
            payload.blob,
            expectedAmount,
            expectedRecipient,
            expectedCurrency,
            store,
            expectedInvoiceId,
            pollTimeout,
            pollInterval,
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
 * Verify a push-mode credential (client already submitted, we have the hash).
 */
async function verifyPush(
  client: Client,
  txHash: string,
  expectedAmount: string,
  expectedRecipient: string,
  expectedCurrency: XrplCurrency,
  store: Store.Store | undefined,
  expectedInvoiceId?: string,
): Promise<Receipt.Receipt> {
  // Mark tx hash as pending BEFORE verification to close the TOCTOU window.
  // In distributed deployments, this prevents two instances from both passing
  // the check before either marks the key.
  if (store) {
    const hashKey = `xrpl:tx:${txHash}`
    const hashUsed = await store.get(hashKey)
    if (hashUsed) {
      throw replayDetected(txHash)
    }
    await store.put(hashKey, { status: 'pending', startedAt: Date.now() })
  }

  // Look up the transaction on-chain
  const txResponse = await client.request({
    command: 'tx',
    transaction: txHash,
  })

  const result = txResponse.result as any
  // xrpl.js v4: transaction fields are nested under tx_json
  const tx = result.tx_json ?? result
  const meta = result.meta ?? result.metaData ?? tx.meta ?? tx.metaData

  if (!meta || meta.TransactionResult !== 'tesSUCCESS') {
    const tecResult = meta?.TransactionResult ?? 'unknown'
    throw fromTecResult(tecResult, `Transaction ${txHash} did not succeed`)
  }

  // Validate the Payment fields match the challenge (use delivered_amount from meta)
  validatePaymentFields(
    tx,
    expectedAmount,
    expectedRecipient,
    expectedCurrency,
    expectedInvoiceId,
    meta,
  )

  // Update to confirmed after successful verification
  if (store) {
    await store.put(`xrpl:tx:${txHash}`, { status: 'confirmed', usedAt: new Date().toISOString() })
  }

  return Receipt.from({
    method: 'xrpl',
    reference: txHash,
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
  expectedAmount: string,
  expectedRecipient: string,
  expectedCurrency: XrplCurrency,
  store: Store.Store | undefined,
  expectedInvoiceId: string | undefined,
  pollTimeout: number,
  pollInterval: number,
): Promise<Receipt.Receipt> {
  // Decode and validate the transaction before submitting
  const decoded = decode(blob) as any

  if (decoded.TransactionType !== 'Payment') {
    throw verificationFailed(
      'SUBMISSION_FAILED',
      `Expected Payment transaction, got ${decoded.TransactionType}`,
    )
  }

  // Validate fields match challenge BEFORE submitting
  validatePaymentFields(
    decoded,
    expectedAmount,
    expectedRecipient,
    expectedCurrency,
    expectedInvoiceId,
  )

  // Derive tx hash from blob BEFORE submit so we can dedup before hitting the network
  const txHash = hashes.hashSignedTx(blob)

  // Mark tx hash as pending BEFORE submitting to close the TOCTOU window
  if (store && txHash) {
    const hashKey = `xrpl:tx:${txHash}`
    const hashUsed = await store.get(hashKey)
    if (hashUsed) {
      throw replayDetected(txHash)
    }
    await store.put(hashKey, { status: 'pending', startedAt: Date.now() })
  }

  const submitResult = await client.submit(blob)
  const engineResult = submitResult.result.engine_result

  if (engineResult !== 'tesSUCCESS' && engineResult !== 'terQUEUED') {
    throw fromTecResult(engineResult, `Transaction submission failed: ${engineResult}`)
  }

  // Wait for validation with configurable timeout and interval
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
        // txnNotFound means not yet validated -- keep polling
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

    // Update to confirmed after successful validation
    if (store) {
      await store.put(`xrpl:tx:${txHash}`, {
        status: 'confirmed',
        usedAt: new Date().toISOString(),
      })
    }

    return Receipt.from({
      method: 'xrpl',
      reference: txHash,
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

/** Validate Payment tx fields (Destination, Amount, Currency, InvoiceID) against challenge. */
function validatePaymentFields(
  tx: any,
  expectedAmount: string,
  expectedRecipient: string,
  expectedCurrency: XrplCurrency,
  expectedInvoiceId?: string,
  meta?: any,
): void {
  rejectPartialPayment(tx)

  if (expectedInvoiceId && tx.InvoiceID !== expectedInvoiceId) {
    throw verificationFailed(
      'SUBMISSION_FAILED',
      `InvoiceID mismatch: expected ${expectedInvoiceId}, got ${tx.InvoiceID ?? 'none'}`,
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
    // XRP native -- amount must be a drops string
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
    // IOU -- validate currency, issuer, and value
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
    // MPT -- validate mpt_issuance_id and value
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
