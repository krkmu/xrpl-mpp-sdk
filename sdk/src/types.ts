import type { NetworkId } from './constants.js'

/** XRP native currency. */
export type XrpCurrency = 'XRP'

/** Issued currency (IOU) on XRPL. */
export type IssuedCurrency = {
  currency: string
  issuer: string
}

/** Multi-Purpose Token on XRPL. */
export type MPToken = {
  mpt_issuance_id: string
}

/** Any supported XRPL currency type. */
export type XrplCurrency = XrpCurrency | IssuedCurrency | MPToken

/** Pull: client signs tx blob, server submits. Push: client submits, sends hash. */
export type PaymentMode = 'pull' | 'push'

/** Lifecycle event emitted by the client charge flow's `onProgress` callback. */
export type ChargeProgressEvent =
  | { type: 'challenge'; recipient: string; amount: string; currency: string }
  | { type: 'preflight' }
  | { type: 'pathfinding' }
  | {
      type: 'paths_resolved'
      strategy: 'self-issued' | 'direct-trustline' | 'cross-issuer'
      sourceAmountValue: string
      sourceAmountCurrency: string
    }
  | { type: 'signing' }
  | { type: 'signed'; mode: PaymentMode }
  | { type: 'submitting' }
  | { type: 'confirmed'; hash: string }

export type ChargeClientConfig = {
  /** Wallet seed or Wallet instance. */
  seed?: string
  /** Payment mode -- pull (default) or push. */
  mode?: PaymentMode
  /**
   * Run pre-flight validation before signing the transaction.
   *
   * When enabled, checks:
   * - Destination account exists on the ledger
   * - Sufficient XRP balance for reserves, fees, and payment amount
   *   (reserves are queried dynamically from the network via server_state)
   * - Rippling is enabled on the issuer for IOU payments
   *
   * @default true
   */
  preflight?: boolean
  /**
   * Slippage buffer applied to SendMax for IOU payments, in basis points
   * (1 bp = 0.01%). The SendMax sent to the ledger is
   * `source_amount * (1 + slippageBps / 10000)`. Range 0-1000 (max 10%).
   *
   * The default 50 bps (0.5%) covers small intra-block price moves on
   * cross-issuer paths and the standard issuer TransferRate range without
   * overpaying for typical liquidity.
   *
   * @default 50
   */
  slippageBps?: number
  /**
   * Backoff delays (ms) between ripple_path_find retries when the first call
   * returns no alternatives. Default `[1000, 2000, 4000]`. Pass an empty
   * array to disable retries.
   */
  pathFindRetryDelaysMs?: number[]
  /** XRPL network. */
  network?: NetworkId
  /** Custom WebSocket RPC URL. */
  rpcUrl?: string
  /** Callback invoked at each lifecycle stage. */
  onProgress?: (event: ChargeProgressEvent) => void
}

export type ChargeServerConfig = {
  /** Recipient XRPL address. */
  recipient: string
  /** Expected currency. */
  currency?: XrplCurrency
  /**
   * Auto-create trustline on the recipient account for IOUs if missing.
   * Requires a seed/wallet to sign the TrustSet transaction.
   * @default false
   */
  autoTrustline?: boolean
  /** Maximum balance willing to hold from issuer when auto-creating trustlines. @default '10000' */
  autoTrustlineLimit?: string
  /**
   * Auto-authorize MPT holding on the recipient account if missing.
   * Requires a seed/wallet to sign the MPTokenAuthorize transaction.
   * @default false
   */
  autoMPTAuthorize?: boolean
  /** Wallet seed for the recipient -- required if autoTrustline or autoMPTAuthorize is set. */
  seed?: string
  /** XRPL network. */
  network?: NetworkId
  /** Custom WebSocket RPC URL. */
  rpcUrl?: string
}

export type ChannelClientConfig = {
  /** Wallet seed or Wallet instance. */
  seed?: string
  /** XRPL network. */
  network?: NetworkId
  /** Custom WebSocket RPC URL. */
  rpcUrl?: string
}

export type ChannelServerConfig = {
  /** Expected channel public key for claim verification. */
  publicKey: string
  /** XRPL network. */
  network?: NetworkId
  /** Custom WebSocket RPC URL. */
  rpcUrl?: string
}
