// -- Network Configuration --

export const XRPL_NETWORK_IDS = {
  mainnet: 0,
  testnet: 1,
  devnet: 2,
} as const

export type NetworkId = keyof typeof XRPL_NETWORK_IDS

export const XRPL_RPC_URLS: Record<NetworkId, string> = {
  mainnet: 'wss://xrplcluster.com',
  testnet: 'wss://s.altnet.rippletest.net:51233',
  devnet: 'wss://s.devnet.rippletest.net:51233',
}

export const XRPL_FAUCET_URLS: Record<NetworkId, string> = {
  mainnet: '',
  testnet: 'https://faucet.altnet.rippletest.net/accounts',
  devnet: 'https://faucet.devnet.rippletest.net/accounts',
}

export const XRPL_EXPLORER_URLS: Record<NetworkId, string> = {
  mainnet: 'https://xrpl.org/transactions/',
  testnet: 'https://testnet.xrpl.org/transactions/',
  devnet: 'https://devnet.xrpl.org/transactions/',
}

// -- Well-Known Currencies --

/** XRP native currency identifier. */
export const XRP = 'XRP' as const

/** RLUSD on mainnet. */
export const RLUSD_MAINNET = {
  currency: 'RLUSD',
  issuer: 'rMxWzrBMyeKR9oJfYBrhAEGsxwsdLFSfim',
} as const

/** RLUSD on testnet. */
export const RLUSD_TESTNET = {
  currency: 'RLUSD',
  issuer: 'rQhWct2fTR9z7bBQaflfqMEr2u8avFFpKH',
} as const

// -- Defaults --

/** XRP has 6 decimal places (drops). */
export const XRP_DECIMALS = 6

/** Default transaction timeout in seconds. */
export const DEFAULT_TIMEOUT = 60

/** Base reserve in drops (currently 10 XRP). */
export const BASE_RESERVE_DROPS = '10000000'

/** Owner reserve per object in drops (currently 2 XRP). */
export const OWNER_RESERVE_DROPS = '2000000'
