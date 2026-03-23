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

// -- Charge Configuration --

export type ChargeClientConfig = {
  /** Wallet seed or Wallet instance. */
  seed?: string
  /** Payment mode -- pull (default) or push. */
  mode?: PaymentMode
  /** Auto-create trustline for IOUs if missing. */
  autoTrustline?: boolean
  /** Maximum balance willing to hold from issuer when auto-creating trustlines. @default '10000' */
  autoTrustlineLimit?: string
  /** Auto-authorize MPT holding if missing. */
  autoMPTAuthorize?: boolean
  /** Run pre-flight validation checks. */
  preflight?: boolean
  /** XRPL network. */
  network?: NetworkId
  /** Custom WebSocket RPC URL. */
  rpcUrl?: string
}

export type ChargeServerConfig = {
  /** Recipient XRPL address. */
  recipient: string
  /** Expected currency. */
  currency?: XrplCurrency
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
