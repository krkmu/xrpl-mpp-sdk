import { Method, Receipt, type Store } from 'mppx'
import { Client, decode, dropsToXrp, verifyPaymentChannelClaim, Wallet } from 'xrpl'
import { type NetworkId, XRPL_RPC_URLS } from '../../constants.js'
import {
  channelClosed,
  channelNotFound,
  invalidSignature,
  replayDetected,
  verificationFailed,
} from '../../errors.js'
import type { ChannelServerConfig } from '../../types.js'
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
    verifyChannelOnChain = false,
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
      const client = new Client(rpcUrl)
      await client.connect()
      try {
        const channelObj = await lookupChannel(client, channelId)
        if (!channelObj) {
          if (store) {
            await store.put(`xrpl:channel:finalized:${channelId}`, {
              reason: 'not_found',
              timestamp: Date.now(),
            })
          }
          throw channelNotFound(channelId)
        }
        if (channelObj.Expiration) {
          const rippleEpoch = 946684800
          const expirationUnix = (channelObj.Expiration + rippleEpoch) * 1000
          if (Date.now() > expirationUnix) {
            if (store) {
              await store.put(`xrpl:channel:finalized:${channelId}`, {
                reason: 'expired',
                timestamp: Date.now(),
              })
            }
            throw channelClosed(channelId)
          }
        }
        // Detect unilateral close by client (CancelAfter or SettleDelay in progress)
        if (channelObj.CancelAfter && onDisputeDetected) {
          const rippleEpoch = 946684800
          const cancelUnix = (channelObj.CancelAfter + rippleEpoch) * 1000
          onDisputeDetected({
            channelId,
            cancelAfter: new Date(cancelUnix).toISOString(),
            balance: channelObj.Amount,
          })
        }
        const channelBalance = BigInt(channelObj.Amount)
        if (newCumulative > channelBalance) {
          throw verificationFailed(
            'AMOUNT_MISMATCH',
            `Cumulative ${newCumulative} exceeds channel balance ${channelBalance}`,
          )
        }
      } finally {
        await client.disconnect()
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
    /** Verify channel existence, balance, and expiration on-chain. @default false */
    verifyChannelOnChain?: boolean
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
