import { Credential, Method } from 'mppx'
import { Client, dropsToXrp, signPaymentChannelClaim, Wallet } from 'xrpl'
import { z } from 'zod/mini'
import { type NetworkId, XRPL_RPC_URLS } from '../../constants.js'
import type { ChannelClientConfig } from '../../types.js'
import { channel as ChannelMethod } from '../Methods.js'

/**
 * Creates an XRPL channel method for use on the **client**.
 *
 * Signs cumulative PayChannel claim commitments off-chain using
 * signPaymentChannelClaim from xrpl.js. Supports both ed25519 and
 * secp256k1 wallets transparently.
 *
 * @example
 * ```ts
 * import { Mppx } from 'mppx/client'
 * import { xrpl } from 'xrpl-mpp-sdk/channel/client'
 *
 * const mppx = Mppx.create({
 *   methods: [
 *     xrpl.channel({ seed: 'sEdV...' }),
 *   ],
 * })
 * ```
 */
export function channel(parameters: channel.Parameters) {
  const { seed, network: defaultNetwork = 'testnet', rpcUrl: _defaultRpcUrl } = parameters

  if (!seed) {
    throw new Error('seed is required for client channel method.')
  }

  const wallet = Wallet.fromSeed(seed)

  return Method.toClient(ChannelMethod, {
    context: z.object({
      cumulativeAmount: z.optional(z.string()),
      action: z.optional(z.enum(['voucher', 'close'])),
    }),
    async createCredential({ challenge, context }) {
      const { request } = challenge
      const { amount, channelId } = request

      const action = context?.action ?? 'voucher'

      // Calculate cumulative amount
      const previousCumulative = BigInt(request.methodDetails?.cumulativeAmount ?? '0')
      const cumulativeAmount =
        context?.cumulativeAmount !== undefined
          ? BigInt(context.cumulativeAmount)
          : previousCumulative + BigInt(amount)

      const cumulativeStr = cumulativeAmount.toString()

      // Sign the claim using xrpl.js -- handles both ed25519 and secp256k1
      // Note: signPaymentChannelClaim expects XRP (not drops) -- it internally calls xrpToDrops
      const cumulativeXrp = dropsToXrp(cumulativeStr).toString()
      const signature = signPaymentChannelClaim(channelId, cumulativeXrp, wallet.privateKey)

      return Credential.serialize({
        challenge,
        payload: {
          action,
          channelId,
          amount: cumulativeStr,
          signature,
        },
        source: `did:pkh:xrpl:${(request.methodDetails?.network as string) ?? defaultNetwork}:${wallet.classicAddress}`,
      })
    },
  })
}

export declare namespace channel {
  export type Parameters = ChannelClientConfig
}

/**
 * Open a new PayChannel on-chain.
 *
 * Creates a PaymentChannelCreate transaction and returns the channel ID.
 */
export async function openChannel(params: {
  seed: string
  destination: string
  amount: string
  settleDelay: number
  publicKey?: string
  cancelAfter?: number
  network?: NetworkId
  rpcUrl?: string
}): Promise<{ channelId: string; txHash: string }> {
  const {
    seed,
    destination,
    amount,
    settleDelay,
    publicKey,
    cancelAfter,
    network = 'testnet',
    rpcUrl,
  } = params

  const wallet = Wallet.fromSeed(seed)
  const resolvedRpcUrl = rpcUrl ?? XRPL_RPC_URLS[network]
  const client = new Client(resolvedRpcUrl)
  await client.connect()

  try {
    const channelCreate: any = {
      TransactionType: 'PaymentChannelCreate',
      Account: wallet.classicAddress,
      Destination: destination,
      Amount: amount,
      SettleDelay: settleDelay,
      PublicKey: publicKey ?? wallet.publicKey,
    }

    if (cancelAfter) {
      channelCreate.CancelAfter = cancelAfter
    }

    const result = await client.submitAndWait(channelCreate, { wallet })
    const meta = result.result.meta as any

    if (meta?.TransactionResult !== 'tesSUCCESS') {
      throw new Error(`PaymentChannelCreate failed: ${meta?.TransactionResult ?? 'unknown'}`)
    }

    // Extract channel ID from affected nodes
    const channelId = extractChannelId(meta)
    const txHash = result.result.hash

    return { channelId, txHash }
  } finally {
    await client.disconnect()
  }
}

/**
 * Fund an existing PayChannel with additional XRP.
 */
export async function fundChannel(params: {
  seed: string
  channelId: string
  amount: string
  network?: NetworkId
  rpcUrl?: string
}): Promise<{ txHash: string }> {
  const { seed, channelId, amount, network = 'testnet', rpcUrl } = params

  const wallet = Wallet.fromSeed(seed)
  const resolvedRpcUrl = rpcUrl ?? XRPL_RPC_URLS[network]
  const client = new Client(resolvedRpcUrl)
  await client.connect()

  try {
    const channelFund = {
      TransactionType: 'PaymentChannelFund' as const,
      Account: wallet.classicAddress,
      Channel: channelId,
      Amount: amount,
    }

    const result = await client.submitAndWait(channelFund, { wallet })
    const meta = result.result.meta as any

    if (meta?.TransactionResult !== 'tesSUCCESS') {
      throw new Error(`PaymentChannelFund failed: ${meta?.TransactionResult ?? 'unknown'}`)
    }

    return { txHash: result.result.hash }
  } finally {
    await client.disconnect()
  }
}

/**
 * Extract the channel ID from PaymentChannelCreate transaction metadata.
 */
function extractChannelId(meta: any): string {
  const nodes = meta.AffectedNodes ?? []
  for (const node of nodes) {
    const created = node.CreatedNode
    if (created?.LedgerEntryType === 'PayChannel') {
      return created.LedgerIndex
    }
  }
  throw new Error('Could not find PayChannel in transaction metadata')
}
