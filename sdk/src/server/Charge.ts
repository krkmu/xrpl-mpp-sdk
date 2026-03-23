import { Method, Receipt, type Store } from 'mppx'
import { Client, decode } from 'xrpl'
import { XRPL_RPC_URLS } from '../constants.js'
import { fromTecResult, replayDetected, verificationFailed } from '../errors.js'
import * as Methods from '../Methods.js'
import type { ChargeServerConfig } from '../types.js'
import { serializeCurrency } from '../utils/currency.js'

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
  const { recipient, currency, network = 'testnet', rpcUrl: customRpcUrl, store } = parameters

  const rpcUrl = customRpcUrl ?? XRPL_RPC_URLS[network]
  const currencyStr = currency ? serializeCurrency(currency) : 'XRP'

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
    const { challenge } = credential
    const { request: challengeRequest } = challenge

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
    const payload = credential.payload

    const client = new Client(rpcUrl)
    await client.connect()

    try {
      switch (payload.type) {
        case 'hash': {
          return await verifyPush(client, payload.hash, expectedAmount, expectedRecipient, store)
        }
        case 'transaction': {
          return await verifyPull(client, payload.blob, expectedAmount, expectedRecipient, store)
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
  store?: Store.Store,
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

  // Validate the Payment fields match the challenge
  validatePaymentFields(tx, expectedAmount, expectedRecipient)

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
  store?: Store.Store,
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
  validatePaymentFields(decoded, expectedAmount, expectedRecipient)

  // Check blob dedup
  // We use the hash computed from the blob as the dedup key
  const submitResult = await client.submit(blob)
  const engineResult = submitResult.result.engine_result

  if (engineResult !== 'tesSUCCESS' && engineResult !== 'terQUEUED') {
    throw fromTecResult(engineResult, `Transaction submission failed: ${engineResult}`)
  }

  const txHash = submitResult.result.tx_json?.hash

  // Check tx hash dedup
  if (store && txHash) {
    const hashKey = `xrpl:tx:${txHash}`
    const hashUsed = await store.get(hashKey)
    if (hashUsed) {
      throw replayDetected(txHash)
    }
  }

  // Wait for validation
  if (txHash) {
    let validated = false
    for (let i = 0; i < 60; i++) {
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
      await new Promise((r) => setTimeout(r, 1000))
    }

    if (!validated) {
      throw verificationFailed(
        'SUBMISSION_FAILED',
        'Transaction not validated after 60 polling attempts',
      )
    }

    // Mark as used after successful validation
    if (store) {
      await store.put(`xrpl:tx:${txHash}`, { usedAt: new Date().toISOString() })
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
 * Validate that a Payment transaction's Destination and Amount match expectations.
 *
 * Handles both legacy format (Amount at top level) and xrpl.js v4 format
 * (fields in tx_json, Amount renamed to DeliverMax).
 */
function validatePaymentFields(tx: any, expectedAmount: string, expectedRecipient: string): void {
  // Validate destination
  const destination = tx.Destination
  if (destination !== expectedRecipient) {
    throw verificationFailed(
      'RECIPIENT_MISMATCH',
      `Expected recipient ${expectedRecipient}, got ${destination}`,
    )
  }

  // Validate amount -- xrpl.js v4 renames Amount to DeliverMax in tx responses
  const txAmount = tx.Amount ?? tx.DeliverMax
  if (typeof txAmount === 'string') {
    // XRP native -- amount is drops string
    if (txAmount !== expectedAmount) {
      throw verificationFailed(
        'AMOUNT_MISMATCH',
        `Expected ${expectedAmount} drops, got ${txAmount}`,
      )
    }
  } else if (txAmount && typeof txAmount === 'object') {
    // IOU or MPT -- compare value field
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
  }
}
