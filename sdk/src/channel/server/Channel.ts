import { Method, Receipt, type Store } from 'mppx'
import { Client, dropsToXrp, verifyPaymentChannelClaim, Wallet } from 'xrpl'
import { type NetworkId, XRPL_RPC_URLS } from '../../constants.js'
import { invalidSignature, replayDetected, verificationFailed } from '../../errors.js'
import type { ChannelServerConfig } from '../../types.js'
import { channel as ChannelMethod } from '../Methods.js'

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
  const { publicKey, network = 'testnet', rpcUrl: customRpcUrl, store } = parameters

  const _rpcUrl = customRpcUrl ?? XRPL_RPC_URLS[network]

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
    const newCumulative = BigInt(payload.amount)
    const signature = payload.signature
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

    // Verify the claim signature using xrpl.js
    // This handles both ed25519 and secp256k1 keys transparently
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

    // Check cumulative amount is strictly monotonic via store
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
      }

      // Update cumulative amount
      await store.put(cumulativeKey, {
        cumulative: payload.amount,
        timestamp: Date.now(),
      })
    }

    // Handle close action
    if (action === 'close') {
      return await closeChannel(channelId, payload.amount, signature)
    }

    // Voucher action -- just return receipt
    return Receipt.from({
      method: 'xrpl',
      reference: `${channelId}:${payload.amount}`,
      status: 'success',
      timestamp: new Date().toISOString(),
    })
  }

  async function closeChannel(
    channelId: string,
    amount: string,
    _signature: string,
  ): Promise<Receipt.Receipt> {
    // Only the channel destination (server) should close
    // We need a wallet seed to submit the close tx -- this requires
    // the server to have its own wallet configured
    // For now, we verify the claim and return a receipt indicating close was requested
    // The actual close submission is handled by the standalone close() function

    return Receipt.from({
      method: 'xrpl',
      reference: `close:${channelId}:${amount}`,
      status: 'success',
      timestamp: new Date().toISOString(),
    })
  }
}

export declare namespace channel {
  export type Parameters = ChannelServerConfig & {
    store?: Store.Store
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
}): Promise<{ txHash: string }> {
  const {
    seed,
    channelId,
    amount,
    signature,
    channelPublicKey,
    network = 'testnet',
    rpcUrl,
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
  } catch {
    return null
  }
}
