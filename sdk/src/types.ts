import type { NetworkId } from './constants.js'

// -- Currency Types --

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

// -- Payment Mode --

/** Pull: client signs tx blob, server submits. Push: client submits, sends hash. */
export type PaymentMode = 'pull' | 'push'

// -- Charge Progress --

export type ChargeProgressEvent =
  | { type: 'challenge'; recipient: string; amount: string; currency: string }
  | { type: 'preflight' }
  | { type: 'signing' }
  | { type: 'signed'; mode: PaymentMode }
  | { type: 'submitting' }
  | { type: 'confirmed'; hash: string }

// -- Charge Configuration --

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

// -- Channel Configuration --

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
