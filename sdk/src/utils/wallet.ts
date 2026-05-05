/**
 * Wallet abstraction for the XRPL MPP SDK.
 *
 * Wraps the underlying xrpl.js {@link XrplWallet} so consumers never need to
 * import from `xrpl` directly. Exposes:
 * - construction from seed, random generation, faucet funding,
 * - the public fields needed to sign and identify the holder,
 * - PayChannel claim signing (drops in -> hex signature out).
 */

import { Client, dropsToXrp, signPaymentChannelClaim, Wallet as XrplWallet } from 'xrpl'
import { type NetworkId, XRPL_RPC_URLS } from '../constants.js'

/** Supported XRPL signing algorithms. */
export type WalletAlgorithm = 'ed25519' | 'ecdsa-secp256k1'

/** Options for {@link Wallet.fromFaucet}. */
export type FromFaucetOptions = {
  /** XRPL network. Mainnet is rejected -- there is no faucet. @default 'testnet' */
  network?: Exclude<NetworkId, 'mainnet'>
  /** Custom WebSocket RPC URL. */
  rpcUrl?: string
}

/**
 * XRPL wallet handle.
 *
 * Holds an xrpl.js Wallet internally. The internal handle is intentionally
 * kept private so the SDK can swap signing backends (HSM, KMS, browser
 * keyring) later without breaking consumer code.
 */
export class Wallet {
  readonly #internal: XrplWallet

  private constructor(internal: XrplWallet) {
    this.#internal = internal
  }

  /** XRPL classic address (r...). */
  get address(): string {
    return this.#internal.classicAddress
  }

  /** Hex-encoded public key. */
  get publicKey(): string {
    return this.#internal.publicKey
  }

  /**
   * Hex-encoded private key. Treat as secret.
   *
   * Exposed for advanced use cases (custom signing flows). Prefer the
   * higher-level signing helpers on this class when available.
   */
  get privateKey(): string {
    return this.#internal.privateKey
  }

  /**
   * Family seed (s...). Treat as secret.
   *
   * May be `undefined` for wallets derived from a raw private key with no
   * known seed.
   */
  get seed(): string | undefined {
    return this.#internal.seed
  }

  /**
   * @internal
   * Underlying xrpl.js Wallet. Used by the SDK internals to autofill / sign
   * transactions. Not part of the public API -- subject to change.
   */
  get _xrplWallet(): XrplWallet {
    return this.#internal
  }

  /** Construct a wallet from a family seed (s... / sEd...). */
  static fromSeed(seed: string): Wallet {
    return new Wallet(XrplWallet.fromSeed(seed))
  }

  /** Generate a brand-new random wallet. Defaults to ed25519. */
  static generate(algorithm: WalletAlgorithm = 'ed25519'): Wallet {
    // xrpl.js exposes its `ECDSA` enum only via `import ECDSA from 'xrpl/dist/npm/ECDSA'`,
    // which isn't a stable named export of the package barrel. The enum's runtime
    // values are exactly the strings 'ed25519' / 'ecdsa-secp256k1', so we cast.
    return new Wallet(XrplWallet.generate(algorithm as never))
  }

  /**
   * Create a wallet and fund it via the network's faucet.
   *
   * Only available on testnet and devnet -- mainnet has no faucet and will
   * throw. The function opens a short-lived xrpl.js Client just for the
   * faucet round-trip and disconnects before returning.
   */
  static async fromFaucet(options: FromFaucetOptions = {}): Promise<Wallet> {
    const network = options.network ?? 'testnet'
    if ((network as NetworkId) === 'mainnet') {
      throw new Error('[xrpl-mpp-sdk] Cannot fund a wallet from a faucet on mainnet.')
    }
    const rpcUrl = options.rpcUrl ?? XRPL_RPC_URLS[network]
    const client = new Client(rpcUrl)
    await client.connect()
    try {
      const { wallet } = await client.fundWallet()
      return new Wallet(wallet)
    } finally {
      await client.disconnect()
    }
  }

  /**
   * Top up this wallet from the network's faucet.
   *
   * Useful when you generated a wallet locally (`Wallet.generate()`) and want
   * to fund it later, or to retry a payment that previously failed for lack
   * of XRP. Same testnet/devnet restrictions as {@link Wallet.fromFaucet}.
   */
  async fundFromFaucet(options: FromFaucetOptions = {}): Promise<void> {
    const network = options.network ?? 'testnet'
    if ((network as NetworkId) === 'mainnet') {
      throw new Error('[xrpl-mpp-sdk] Cannot fund a wallet from a faucet on mainnet.')
    }
    const rpcUrl = options.rpcUrl ?? XRPL_RPC_URLS[network]
    const client = new Client(rpcUrl)
    await client.connect()
    try {
      await client.fundWallet(this.#internal)
    } finally {
      await client.disconnect()
    }
  }

  /**
   * Sign a cumulative PayChannel claim.
   *
   * @param channelId 64-hex-character channel ID returned by `openChannel`.
   * @param drops Cumulative claim amount, in drops.
   * @returns Hex-encoded signature suitable for `PaymentChannelClaim` /
   * off-chain voucher payloads.
   */
  signChannelClaim(channelId: string, drops: string): string {
    const xrp = dropsToXrp(drops).toString()
    return signPaymentChannelClaim(channelId, xrp, this.#internal.privateKey)
  }
}

/**
 * Resolve a wallet from either a Wallet instance or a seed string.
 *
 * Used by SDK entry points that historically accepted only a seed. New code
 * should prefer passing a {@link Wallet} directly.
 *
 * @internal
 */
export function resolveWallet(input: { wallet?: Wallet; seed?: string }): Wallet {
  if (input.wallet) return input.wallet
  if (input.seed) return Wallet.fromSeed(input.seed)
  throw new Error('[xrpl-mpp-sdk] A wallet or seed is required.')
}
