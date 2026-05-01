import { Method, Receipt, type Store } from 'mppx'
import { Client, decode, dropsToXrp, verifyPaymentChannelClaim, Wallet } from 'xrpl'
import { type NetworkId, XRPL_RPC_URLS } from '../../constants.js'
import {
  channelClosed,
  channelExhausted,
  channelNotFound,
  invalidSignature,
  replayDetected,
  verificationFailed,
} from '../../errors.js'
import type { ChannelServerConfig } from '../../types.js'
import { classicAddressFromDID, classicAddressFromPublicKey } from '../../utils/did.js'
import { channel as ChannelMethod } from '../Methods.js'

/** Default max challenge age: 5 minutes. */
const DEFAULT_MAX_CHALLENGE_AGE_MS = 5 * 60 * 1000

/**
 * Creates an XRPL channel method for use on the **server**.
 *
 * Verifies off-chain PayChannel claims using verifyPaymentChannelClaim
 * from xrpl.js, tracks cumulative amounts via Store, and supports
 * closing channels on-chain.
 *
 * @example
 * ```ts
 * import { Mppx, Store } from 'mppx/server'
 * import { xrpl } from 'xrpl-mpp-sdk/channel/server'
 *
 * const mppx = Mppx.create({
 *   methods: [
 *     xrpl.channel({
 *       publicKey: 'ED...',
 *     }),
 *   ],
 * })
 * ```
 */
export function channel(parameters: channel.Parameters) {
  const {
    publicKey,
    network = 'testnet',
    rpcUrl: customRpcUrl,
    store,
    requireStore = true,
    maxChallengeAge = DEFAULT_MAX_CHALLENGE_AGE_MS,
    verifyChannelOnChain = true,
    channelMetadataTtlMs = 60_000,
    channelLookup,
    onDisputeDetected,
  } = parameters

  if (!store && requireStore) {
    throw new Error(
      '[xrpl-mpp-sdk] store is required for replay protection and cumulative tracking. ' +
        'Pass requireStore: false to explicitly disable.',
    )
  }

  const rpcUrl = customRpcUrl ?? XRPL_RPC_URLS[network]

  // Serialize verify operations to prevent concurrent race conditions
  let verifyLock: Promise<unknown> = Promise.resolve()

  return Method.toServer(ChannelMethod, {
    async request({ request }) {
      // Look up current cumulative from store so clients know where to resume
      let cumulativeAmount = '0'
      if (store && request.channelId) {
        const state = (await store.get(`xrpl:channel:${request.channelId}`)) as any
        if (state?.cumulative) {
          cumulativeAmount = state.cumulative
        }
      }
      return {
        ...request,
        methodDetails: {
          ...request.methodDetails,
          reference: crypto.randomUUID(),
          network,
          cumulativeAmount,
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
    const payload = credential.payload
    const channelId = payload.channelId

    // Bind the credential to its DID-encoded sender. The address derived from
    // the configured channel publicKey must match the credential source --
    // otherwise an attacker can replay claims under their own DID.
    const expectedSenderAddress = classicAddressFromPublicKey(publicKey)
    const credentialSenderAddress = classicAddressFromDID(credential.source)
    if (credentialSenderAddress !== expectedSenderAddress) {
      throw verificationFailed(
        'SOURCE_MISMATCH',
        `Credential source ${credentialSenderAddress} does not match channel funder ${expectedSenderAddress}`,
      )
    }

    // Reject credentials on finalized channels
    if (store && channelId) {
      const finalized = await store.get(`xrpl:channel:finalized:${channelId}`)
      if (finalized) {
        throw channelClosed(channelId)
      }
    }

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

    const action = payload.action ?? 'voucher'

    // Challenge replay protection
    if (store) {
      const challengeKey = `xrpl:challenge:${challenge.id}`
      const existing = await store.get(challengeKey)
      if (existing) {
        throw replayDetected(challenge.id)
      }
      await store.put(challengeKey, { usedAt: new Date().toISOString() })
    }

    // Handle open action -- broadcast PaymentChannelCreate and init store
    if (action === 'open') {
      return await doVerifyOpen(credential)
    }

    const newCumulative = BigInt(payload.amount)
    const signature = payload.signature
    const requestedAmount = BigInt(challenge.request?.amount ?? '0')

    // verifyPaymentChannelClaim expects XRP (not drops) -- it internally calls xrpToDrops
    const claimXrp = dropsToXrp(payload.amount).toString()
    let isValid: boolean
    try {
      isValid = verifyPaymentChannelClaim(channelId, claimXrp, signature, publicKey)
    } catch {
      // xrpl.js throws on malformed or cross-curve signatures instead of returning false
      isValid = false
    }

    if (!isValid) {
      throw invalidSignature('Claim signature verification failed')
    }

    if (verifyChannelOnChain) {
      const lookup = channelLookup ?? defaultChannelLookup(rpcUrl)
      const channelMeta = await loadChannelMetadata({
        channelId,
        store,
        ttlMs: channelMetadataTtlMs,
        lookup,
        forceRefresh: false,
      })
      assertChannelHealthy({ channelId, meta: channelMeta, store, onDisputeDetected })
      let channelBalance = BigInt(channelMeta.amount)
      // Cumulative exceeds the cached balance: re-fetch once -- the funder may
      // have topped up via PaymentChannelFund since we last looked.
      if (newCumulative > channelBalance) {
        const refreshed = await loadChannelMetadata({
          channelId,
          store,
          ttlMs: channelMetadataTtlMs,
          lookup,
          forceRefresh: true,
        })
        assertChannelHealthy({ channelId, meta: refreshed, store, onDisputeDetected })
        channelBalance = BigInt(refreshed.amount)
        if (newCumulative > channelBalance) {
          throw channelExhausted(channelId, newCumulative, channelBalance)
        }
      }
    }

    // Check cumulative amount is strictly monotonic via store
    // Note: in distributed deployments, concurrent requests may race here.
    // For single-instance deployments, the verifyLock serializes access.
    if (store) {
      const cumulativeKey = `xrpl:channel:${channelId}`
      const state = (await store.get(cumulativeKey)) as any

      if (state) {
        const previousCumulative = BigInt(state.cumulative)

        if (newCumulative <= previousCumulative) {
          if (newCumulative === previousCumulative) {
            throw replayDetected(`${channelId}:${payload.amount}`)
          }
          throw verificationFailed(
            'AMOUNT_MISMATCH',
            `New cumulative ${newCumulative} is less than previous ${previousCumulative}`,
          )
        }

        if (requestedAmount > 0n && newCumulative < previousCumulative + requestedAmount) {
          throw verificationFailed(
            'AMOUNT_MISMATCH',
            `Cumulative ${newCumulative} does not cover requested amount ${requestedAmount} (expected >= ${previousCumulative + requestedAmount})`,
          )
        }
      }

      // Update cumulative amount
      await store.put(cumulativeKey, {
        cumulative: payload.amount,
        signature,
        timestamp: Date.now(),
      })
    }

    return Receipt.from({
      method: 'xrpl',
      reference: `${channelId}:${payload.amount}`,
      ...(challenge.id ? { externalId: challenge.id } : {}),
      status: 'success',
      timestamp: new Date().toISOString(),
    })
  }

  async function doVerifyOpen(credential: any): Promise<Receipt.Receipt> {
    const { challenge, payload } = credential
    const blob = payload.transaction as string

    // Decode and validate the tx is a PaymentChannelCreate
    let decoded: any
    try {
      decoded = decode(blob)
    } catch {
      throw verificationFailed('SUBMISSION_FAILED', 'Could not decode open transaction blob')
    }

    if (decoded.TransactionType !== 'PaymentChannelCreate') {
      throw verificationFailed(
        'SUBMISSION_FAILED',
        `Expected PaymentChannelCreate, got ${decoded.TransactionType}`,
      )
    }

    // Verify destination matches the server's expected recipient
    const expectedRecipient = challenge.request?.recipient
    if (expectedRecipient && decoded.Destination !== expectedRecipient) {
      throw verificationFailed(
        'RECIPIENT_MISMATCH',
        `Channel destination ${decoded.Destination} does not match expected ${expectedRecipient}`,
      )
    }

    // Verify the public key matches what the server expects
    if (decoded.PublicKey?.toUpperCase() !== publicKey.toUpperCase()) {
      throw verificationFailed(
        'SUBMISSION_FAILED',
        `Channel PublicKey ${decoded.PublicKey} does not match expected ${publicKey}`,
      )
    }

    // Bind the on-chain Account (funder) to the credential's DID source. doVerify()
    // already verified that the credential source matches the address derived from
    // publicKey, but this re-asserts the binding inside the open path so any
    // refactor that splits these flows keeps the invariant.
    const credentialSenderAddress = classicAddressFromDID(credential.source)
    if (decoded.Account !== credentialSenderAddress) {
      throw verificationFailed(
        'SOURCE_MISMATCH',
        `Channel Account ${decoded.Account} does not match credential source ${credentialSenderAddress}`,
      )
    }

    // Broadcast the tx
    const client = new Client(rpcUrl)
    await client.connect()

    try {
      const submitResult = await client.submit(blob)
      const engineResult = submitResult.result.engine_result

      if (engineResult !== 'tesSUCCESS' && engineResult !== 'terQUEUED') {
        throw verificationFailed(
          'SUBMISSION_FAILED',
          `PaymentChannelCreate submission failed: ${engineResult}`,
        )
      }

      // Poll for confirmation
      const txHash = submitResult.result.tx_json?.hash
      if (!txHash) {
        throw verificationFailed('SUBMISSION_FAILED', 'No tx hash returned from submit')
      }

      let meta: any
      for (let i = 0; i < 60; i++) {
        try {
          const txResponse = await client.request({ command: 'tx', transaction: txHash })
          meta = (txResponse.result as any).meta ?? (txResponse.result as any).metaData
          if (meta?.TransactionResult === 'tesSUCCESS') break
          if (meta?.TransactionResult && meta.TransactionResult !== 'tesSUCCESS') {
            throw verificationFailed(
              'SUBMISSION_FAILED',
              `PaymentChannelCreate failed: ${meta.TransactionResult}`,
            )
          }
        } catch (err: any) {
          if (err?.data?.error !== 'txnNotFound') throw err
        }
        await new Promise((r) => setTimeout(r, 1000))
      }

      if (!meta || meta.TransactionResult !== 'tesSUCCESS') {
        throw verificationFailed('SUBMISSION_FAILED', 'PaymentChannelCreate not confirmed in time')
      }

      // Extract channelId from metadata
      const channelId = extractChannelIdFromMeta(meta)

      // Verify initial claim signature against the real channelId
      const initialAmount = payload.amount
      const initialXrp = dropsToXrp(initialAmount).toString()
      let sigValid: boolean
      try {
        sigValid = verifyPaymentChannelClaim(channelId, initialXrp, payload.signature, publicKey)
      } catch {
        sigValid = false
      }

      // If the client signed with a placeholder channelId, the sig won't match.
      // In that case, we just init the store without verifying the initial claim.
      // The first real voucher will be verified normally.

      if (store) {
        if (sigValid) {
          await store.put(`xrpl:channel:${channelId}`, {
            cumulative: initialAmount,
            signature: payload.signature,
            timestamp: Date.now(),
          })
        } else {
          await store.put(`xrpl:channel:${channelId}`, {
            cumulative: '0',
            signature: '',
            timestamp: Date.now(),
          })
        }
      }

      return Receipt.from({
        method: 'xrpl',
        reference: `open:${channelId}:${txHash}`,
        ...(challenge.id ? { externalId: challenge.id } : {}),
        status: 'success',
        timestamp: new Date().toISOString(),
      })
    } finally {
      await client.disconnect()
    }
  }
}

/** Cached PayChannel metadata. */
type CachedChannelMeta = {
  amount: string
  expiration: number | null
  cancelAfter: number | null
  cachedAt: number
}

/** Looks up a PayChannel object on-chain by channel ID. Returns null if missing. */
export type ChannelLookup = (channelId: string) => Promise<PayChannelLedgerEntry | null>

/** Subset of PayChannel ledger entry fields the SDK consumes. */
export type PayChannelLedgerEntry = {
  Account: string
  Destination: string
  Amount: string
  Balance?: string
  Expiration?: number | null
  CancelAfter?: number | null
}

/** Default channel lookup uses xrpl.js Client + ledger_entry. */
function defaultChannelLookup(rpcUrl: string): ChannelLookup {
  return async (channelId) => {
    const client = new Client(rpcUrl)
    await client.connect()
    try {
      return (await lookupChannel(client, channelId)) as PayChannelLedgerEntry | null
    } finally {
      await client.disconnect()
    }
  }
}

/**
 * Fetch channel metadata, using the store as a TTL cache. The cache is keyed
 * by channelId and refreshes when stale or when `forceRefresh` is set.
 *
 * Without a store, every call hits the ledger.
 */
async function loadChannelMetadata(params: {
  channelId: string
  store: Store.Store | undefined
  ttlMs: number
  lookup: ChannelLookup
  forceRefresh: boolean
}): Promise<CachedChannelMeta> {
  const { channelId, store, ttlMs, lookup, forceRefresh } = params
  const cacheKey = `xrpl:channel:meta:${channelId}`

  if (!forceRefresh && store && ttlMs > 0) {
    const cached = (await store.get(cacheKey)) as CachedChannelMeta | null
    if (cached && Date.now() - cached.cachedAt < ttlMs) {
      return cached
    }
  }

  const channelObj = await lookup(channelId)
  if (!channelObj) {
    if (store) {
      await store.put(`xrpl:channel:finalized:${channelId}`, {
        reason: 'not_found',
        timestamp: Date.now(),
      })
    }
    throw channelNotFound(channelId)
  }
  const meta: CachedChannelMeta = {
    amount: channelObj.Amount,
    expiration: channelObj.Expiration ?? null,
    cancelAfter: channelObj.CancelAfter ?? null,
    cachedAt: Date.now(),
  }
  if (store) {
    await store.put(cacheKey, meta)
  }
  return meta
}

/** Reject claims on expired channels and emit a dispute callback for pending close. */
function assertChannelHealthy(params: {
  channelId: string
  meta: CachedChannelMeta
  store: Store.Store | undefined
  onDisputeDetected: ((state: ChannelDisputeState) => void) | undefined
}): void {
  const { channelId, meta, store, onDisputeDetected } = params
  const rippleEpoch = 946684800
  if (meta.expiration !== null) {
    const expirationUnix = (meta.expiration + rippleEpoch) * 1000
    if (Date.now() > expirationUnix) {
      if (store) {
        // Mark finalized fire-and-forget; we re-check on next call anyway.
        void store.put(`xrpl:channel:finalized:${channelId}`, {
          reason: 'expired',
          timestamp: Date.now(),
        })
      }
      throw channelClosed(channelId)
    }
  }
  if (meta.cancelAfter !== null && onDisputeDetected) {
    const cancelUnix = (meta.cancelAfter + rippleEpoch) * 1000
    onDisputeDetected({
      channelId,
      cancelAfter: new Date(cancelUnix).toISOString(),
      balance: meta.amount,
    })
  }
}

/** Extract channelId from PaymentChannelCreate metadata. */
function extractChannelIdFromMeta(meta: any): string {
  const nodes = meta.AffectedNodes ?? []
  for (const node of nodes) {
    if (node.CreatedNode?.LedgerEntryType === 'PayChannel') {
      return node.CreatedNode.LedgerIndex
    }
  }
  throw new Error('Could not find PayChannel in transaction metadata')
}

/** Dispute state passed to onDisputeDetected callback. */
export type ChannelDisputeState = {
  channelId: string
  cancelAfter: string
  balance: string
}

export declare namespace channel {
  export type Parameters = ChannelServerConfig & {
    store?: Store.Store
    /** Require a store for replay protection. @default true */
    requireStore?: boolean
    /** Max challenge age in milliseconds. 0 disables. @default 300000 (5 min) */
    maxChallengeAge?: number
    /**
     * Verify channel existence, balance, and expiration on-chain. The first
     * voucher per channel hits the ledger; subsequent vouchers reuse cached
     * metadata until {@link channelMetadataTtlMs} elapses or the cumulative
     * exceeds the cached balance (re-fetch to detect a PaymentChannelFund top-up).
     * @default true
     */
    verifyChannelOnChain?: boolean
    /**
     * Time in ms to cache channel metadata (Amount, Expiration, CancelAfter)
     * after a successful on-chain lookup. Set to 0 to disable caching.
     * @default 60000 (1 minute)
     */
    channelMetadataTtlMs?: number
    /**
     * Override the on-chain channel lookup. The default implementation uses
     * xrpl.js + `ledger_entry`. Set to inject a custom resolver (e.g. for
     * testing or to share a long-lived Client across verifies).
     */
    channelLookup?: ChannelLookup
    /** Called when a unilateral close is detected on-chain (CancelAfter set). */
    onDisputeDetected?: (state: ChannelDisputeState) => void
  }
}

/**
 * Close a PayChannel on-chain.
 *
 * Behavior depends on who submits:
 * - **Source (funder)**: submits PaymentChannelClaim with tfClose + claim details.
 *   This initiates the settle delay, after which the channel can be deleted.
 * - **Destination (recipient)**: submits PaymentChannelClaim to redeem funds
 *   (without tfClose, since only the source can set tfClose on current XRPL).
 *
 * The function looks up the channel on-chain to detect the caller's role.
 */
export async function close(params: {
  seed: string
  channelId: string
  amount: string
  signature: string
  /** The channel's public key (from PaymentChannelCreate). Required for signature verification. */
  channelPublicKey: string
  network?: NetworkId
  rpcUrl?: string
  /** Store to mark the channel as finalized after close. */
  store?: Store.Store
}): Promise<{ txHash: string }> {
  const {
    seed,
    channelId,
    amount,
    signature,
    channelPublicKey,
    network = 'testnet',
    rpcUrl,
    store: closeStore,
  } = params

  const wallet = Wallet.fromSeed(seed)
  const resolvedRpcUrl = rpcUrl ?? XRPL_RPC_URLS[network]
  const client = new Client(resolvedRpcUrl)
  await client.connect()

  try {
    // Look up the channel to determine the caller's role
    const channelObj = await lookupChannel(client, channelId)
    const isSource = channelObj?.Account === wallet.classicAddress

    // tfClose = 0x00010000 -- only the source can use this flag
    const TF_CLOSE = 0x00010000

    const channelClaim = {
      TransactionType: 'PaymentChannelClaim' as const,
      Account: wallet.classicAddress,
      Channel: channelId,
      Balance: amount,
      Amount: amount,
      Signature: signature.toUpperCase(),
      PublicKey: channelPublicKey,
      ...(isSource ? { Flags: TF_CLOSE } : {}),
    }

    const result = await client.submitAndWait(channelClaim, { wallet })
    const meta = result.result.meta as any

    if (meta?.TransactionResult !== 'tesSUCCESS') {
      throw new Error(`PaymentChannelClaim (close) failed: ${meta?.TransactionResult ?? 'unknown'}`)
    }

    if (closeStore) {
      await closeStore.put(`xrpl:channel:finalized:${channelId}`, {
        reason: 'closed',
        txHash: result.result.hash,
        timestamp: Date.now(),
      })
    }

    return { txHash: result.result.hash }
  } finally {
    await client.disconnect()
  }
}

/**
 * Look up a PayChannel object on-chain by channel ID.
 */
async function lookupChannel(client: Client, channelId: string): Promise<any | null> {
  try {
    const response = await client.request({
      command: 'ledger_entry',
      index: channelId,
    } as any)
    return (response.result as any).node ?? null
  } catch (err: any) {
    // entryNotFound means the channel does not exist -- return null
    if (err?.data?.error === 'entryNotFound') return null
    // Re-throw network errors so callers can handle them
    throw err
  }
}
