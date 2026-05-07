import { Method, Receipt, type Store } from 'mppx'
import { Client, decode, dropsToXrp, verifyPaymentChannelClaim } from 'xrpl'
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
import { assertTxExpiresWithinChallenge, readCurrentLedgerIndex } from '../../utils/ledger-time.js'
import { resolveWallet, type Wallet } from '../../utils/wallet.js'
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

  // Serialise verify calls so per-channel monotonicity checks don't race.
  let verifyLock: Promise<unknown> = Promise.resolve()

  return Method.toServer(ChannelMethod, {
    async request({ request }) {
      // Surface the current cumulative so clients know where to resume.
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

    if (store && channelId) {
      const finalized = await store.get(`xrpl:channel:finalized:${channelId}`)
      if (finalized) {
        throw channelClosed(channelId)
      }
    }

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

    if (store) {
      const challengeKey = `xrpl:challenge:${challenge.id}`
      const existing = await store.get(challengeKey)
      if (existing) {
        throw replayDetected(challenge.id)
      }
      await store.put(challengeKey, { usedAt: new Date().toISOString() })
    }

    if (action === 'open') {
      return await doVerifyOpen(credential)
    }

    const newCumulative = BigInt(payload.amount)
    const signature = payload.signature
    const requestedAmount = BigInt(challenge.request?.amount ?? '0')

    // verifyPaymentChannelClaim expects XRP, not drops -- it internally calls xrpToDrops.
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

    // Single-instance deployments serialise via verifyLock above; distributed
    // deployments using a shared Store can race here -- atomic compare-and-set
    // would be needed.
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

    const expectedRecipient = challenge.request?.recipient
    if (expectedRecipient && decoded.Destination !== expectedRecipient) {
      throw verificationFailed(
        'RECIPIENT_MISMATCH',
        `Channel destination ${decoded.Destination} does not match expected ${expectedRecipient}`,
      )
    }

    if (decoded.PublicKey?.toUpperCase() !== publicKey.toUpperCase()) {
      throw verificationFailed(
        'SUBMISSION_FAILED',
        `Channel PublicKey ${decoded.PublicKey} does not match expected ${publicKey}`,
      )
    }

    // Re-assert the funder/source binding inside the open path. doVerify()
    // already checked source vs publicKey-derived address; this also covers
    // the funder (decoded.Account) so a refactor that splits the paths
    // doesn't drop the invariant.
    const credentialSenderAddress = classicAddressFromDID(credential.source)
    if (decoded.Account !== credentialSenderAddress) {
      throw verificationFailed(
        'SOURCE_MISMATCH',
        `Channel Account ${decoded.Account} does not match credential source ${credentialSenderAddress}`,
      )
    }

    const client = new Client(rpcUrl)
    await client.connect()

    try {
      // Reject open blobs whose LastLedgerSequence would let them land past
      // challenge.expires *before* spending a submit. Mirrors the same gate
      // applied to charge in server/Charge.ts -- without it, an attacker who
      // intercepts a signed PaymentChannelCreate can replay it on-ledger
      // after the challenge has logically expired.
      const challengeExpires = (challenge as { expires?: string }).expires
      const txLLS = (decoded as { LastLedgerSequence?: number }).LastLedgerSequence
      if (challengeExpires && typeof txLLS === 'number') {
        const currentLedgerIndex = await readCurrentLedgerIndex(client)
        try {
          assertTxExpiresWithinChallenge({
            txLastLedgerSequence: txLLS,
            currentLedgerIndex,
            expiresIso: challengeExpires,
          })
        } catch (err: any) {
          const reason =
            typeof err?.message === 'string'
              ? err.message
              : 'LastLedgerSequence vs challenge expiry check failed'
          // Strip the helper's `[CODE] ` prefix so verificationFailed's own
          // prefix is not duplicated.
          const detail = reason.replace(/^\[[^\]]+\]\s*/, '')
          throw verificationFailed('SUBMISSION_FAILED', detail)
        }
      }

      const submitResult = await client.submit(blob)
      const engineResult = submitResult.result.engine_result

      if (engineResult !== 'tesSUCCESS' && engineResult !== 'terQUEUED') {
        throw verificationFailed(
          'SUBMISSION_FAILED',
          `PaymentChannelCreate submission failed: ${engineResult}`,
        )
      }

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

      const channelId = extractChannelIdFromMeta(meta)

      // Validate the initial claim against the real channelId.
      //
      // The client cannot know the channelId at sign time, so the open-action
      // signature is typically computed against an all-zero placeholder. Two
      // legitimate cases:
      //   (a) initialAmount === 0: client is opening without an initial
      //       commitment. The signature carries no value claim, so the
      //       placeholder vs real-channelId mismatch is fine. Store
      //       cumulative=0 and let the first real voucher set the floor.
      //   (b) initialAmount > 0 AND the signature verifies against the real
      //       channelId: the client knew the channelId in advance (rare but
      //       valid). Honor it.
      //
      // Anything else (initialAmount > 0 and sig does NOT verify) is rejected.
      // Silently zeroing the cumulative would discard the funder's stated
      // initial commitment and hide client bugs (wrong wallet, off-by-one
      // channelId, wrong amount in the sig vs the payload).
      const initialAmount = payload.amount
      const initialAmountBig = BigInt(initialAmount)

      if (initialAmountBig > 0n) {
        const initialXrp = dropsToXrp(initialAmount).toString()
        let sigValid: boolean
        try {
          sigValid = verifyPaymentChannelClaim(channelId, initialXrp, payload.signature, publicKey)
        } catch {
          sigValid = false
        }
        if (!sigValid) {
          throw invalidSignature(
            `Initial claim signature does not verify against the real channelId ${channelId}. ` +
              'Set request.amount to "0" on the open action to commit nothing, or sign ' +
              'against the real channelId after it is known.',
          )
        }
      }

      if (store) {
        await store.put(`xrpl:channel:${channelId}`, {
          cumulative: initialAmountBig > 0n ? initialAmount : '0',
          signature: initialAmountBig > 0n ? payload.signature : '',
          timestamp: Date.now(),
        })
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
  /** Wallet of the closer (funder or recipient). Preferred over `seed`. */
  wallet?: Wallet
  /** Family seed of the closer. Kept for backward compatibility -- prefer `wallet`. */
  seed?: string
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
    wallet: walletInput,
    seed,
    channelId,
    amount,
    signature,
    channelPublicKey,
    network = 'testnet',
    rpcUrl,
    store: closeStore,
  } = params

  const wallet = resolveWallet({ wallet: walletInput, seed })
  const resolvedRpcUrl = rpcUrl ?? XRPL_RPC_URLS[network]
  const client = new Client(resolvedRpcUrl)
  await client.connect()

  try {
    const channelObj = await lookupChannel(client, channelId)
    const isSource = channelObj?.Account === wallet.address

    // tfClose = 0x00010000. Only the source (funder) is allowed to set it.
    const TF_CLOSE = 0x00010000

    const channelClaim = {
      TransactionType: 'PaymentChannelClaim' as const,
      Account: wallet.address,
      Channel: channelId,
      Balance: amount,
      Amount: amount,
      Signature: signature.toUpperCase(),
      PublicKey: channelPublicKey,
      ...(isSource ? { Flags: TF_CLOSE } : {}),
    }

    const result = await client.submitAndWait(channelClaim, { wallet: wallet._xrplWallet })
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
    if (err?.data?.error === 'entryNotFound') return null
    throw err
  }
}
