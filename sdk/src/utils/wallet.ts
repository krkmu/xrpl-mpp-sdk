/**
 * Wallet abstraction for the XRPL MPP SDK.
 *
 * Wraps the underlying xrpl.js {@link XrplWallet} so consumers never need to
 * import from `xrpl` directly. Exposes:
 * - construction from seed, random generation, faucet funding,
 * - the public fields needed to sign and identify the holder,
 * - PayChannel claim signing (drops in -> hex signature out),
 * - token-level operations (accept / refuse, transfer, issue, freeze,
 *   authorize, clawback, ...) that hide every TrustSet / AccountSet detail.
 */

import { Client, dropsToXrp, signPaymentChannelClaim, Wallet as XrplWallet } from 'xrpl'
import { type NetworkId, XRPL_RPC_URLS } from '../constants.js'
import type { IssuedCurrency } from '../types.js'
import {
  ASF_ALLOW_TRUSTLINE_CLAWBACK,
  ASF_DEFAULT_RIPPLE,
  ASF_REQUIRE_AUTH,
  authorizeTrustline,
  clawbackTokens,
  getTrustline,
  issuePayment,
  listTrustlines,
  removeTrustline,
  type SetTrustlineOptions,
  type SetTrustlineResult,
  setAccountFlag,
  setIssuerFreeze,
  setTrustline,
  type TrustlineInfo,
} from './trustline.js'

/** Supported XRPL signing algorithms. */
export type WalletAlgorithm = 'ed25519' | 'ecdsa-secp256k1'

/** Common network selection accepted by every Wallet method that hits the ledger. */
export type NetworkOptions = {
  /** XRPL network. @default 'testnet' */
  network?: NetworkId
  /** Custom WebSocket RPC URL. Overrides `network` when present. */
  rpcUrl?: string
}

/** Options for {@link Wallet.fromFaucet}. */
export type FromFaucetOptions = {
  /** XRPL network. Mainnet is rejected -- there is no faucet. @default 'testnet' */
  network?: Exclude<NetworkId, 'mainnet'>
  /** Custom WebSocket RPC URL. */
  rpcUrl?: string
}

/** Options for token-level operations on Wallet. */
export type TokenOptions = NetworkOptions & SetTrustlineOptions

/**
 * XRPL wallet handle.
 *
 * Holds an xrpl.js Wallet internally. The internal handle is intentionally
 * kept private so the SDK can swap signing backends (HSM, KMS, browser
 * keyring) later without breaking consumer code.
 */
export class Wallet {
  readonly #internal: XrplWallet
  /**
   * Per-wallet write queue. XRPL assigns a `Sequence` per account; submitting
   * two transactions concurrently from the same wallet leads to one of them
   * being rejected with `tefPAST_SEQ` once the first lands. The queue chains
   * every mutating Wallet call so users can `Promise.all([...])` freely
   * without thinking about sequence collisions. Read-only calls
   * (`holdsToken`, `listAcceptedTokens`) bypass the queue.
   */
  #writeQueue: Promise<unknown> = Promise.resolve()

  private constructor(internal: XrplWallet) {
    this.#internal = internal
  }

  /**
   * Run a write operation under the per-wallet serialisation queue. Each
   * call opens its own short-lived xrpl.Client. An error in one operation
   * does not block subsequent ones (we swallow it on the queue chain only).
   */
  async #submit<T>(options: NetworkOptions, fn: (client: Client) => Promise<T>): Promise<T> {
    const run = (): Promise<T> => withClient(options, fn)
    const next = this.#writeQueue.then(run, run)
    this.#writeQueue = next.catch(() => undefined)
    return next
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

  // ===== Holder operations =====

  /**
   * Opt in to receive a token. Creates (or updates the limit of) the
   * trustline for the given IOU on this wallet.
   *
   * Idempotent: returns `unchanged` when the line already exists at the
   * desired limit. Returns `pending_authorization` when the issuer has
   * RequireAuth set and has not yet authorised this account -- the line
   * exists on the holder side but cannot hold a balance until the issuer
   * runs `wallet.authorize(holder, currency)` from their side.
   */
  async acceptToken(
    currency: IssuedCurrency,
    options: TokenOptions = {},
  ): Promise<SetTrustlineResult> {
    return this.#submit(options, (client) =>
      setTrustline(client, this.#internal, currency, {
        ...(options.limit !== undefined ? { limit: options.limit } : {}),
        ...(options.noRipple !== undefined ? { noRipple: options.noRipple } : {}),
      }),
    )
  }

  /**
   * Stop holding a token. Refuses to submit if the wallet still holds a
   * non-zero balance (send the balance back to the issuer first, or have
   * the issuer claw it back).
   *
   * Three possible outcomes:
   * - `absent`: there was no trustline -- nothing happened.
   * - `removed`: the trustline ledger entry has been deleted; the holder's
   *   owner reserve is freed.
   * - `cleared`: the TrustSet succeeded but a non-default flag (typically
   *   `tfSetfAuth` on a `requireAuthorization` issuer) keeps the entry
   *   pinned to the ledger at limit=0 / balance=0. The reserve stays locked
   *   until the issuer relaxes the flag.
   */
  async refuseToken(
    currency: IssuedCurrency,
    options: NetworkOptions = {},
  ): Promise<
    { status: 'absent' } | { status: 'removed'; hash: string } | { status: 'cleared'; hash: string }
  > {
    return this.#submit(options, (client) => removeTrustline(client, this.#internal, currency))
  }

  /** Read the wallet's current state for a given token. Returns null if not held. */
  async holdsToken(
    currency: IssuedCurrency,
    options: NetworkOptions = {},
  ): Promise<TrustlineInfo | null> {
    return withClient(options, (client) => getTrustline(client, this.address, currency))
  }

  /** List every token this wallet has accepted. */
  async listAcceptedTokens(options: NetworkOptions = {}): Promise<TrustlineInfo[]> {
    return withClient(options, (client) => listTrustlines(client, this.address))
  }

  // ===== Issuer operations =====

  /**
   * Allow this wallet's tokens to flow through intermediary accounts
   * (`asfDefaultRipple`). Required by anyone who acts as an issuer of an
   * IOU -- without it, holders of the token cannot pay each other through
   * the issuer.
   */
  async enableTransfers(options: NetworkOptions = {}): Promise<{ hash: string }> {
    return this.#submit(options, (client) =>
      setAccountFlag(client, this.#internal, ASF_DEFAULT_RIPPLE, true),
    )
  }

  /** Inverse of {@link Wallet.enableTransfers}. */
  async disableTransfers(options: NetworkOptions = {}): Promise<{ hash: string }> {
    return this.#submit(options, (client) =>
      setAccountFlag(client, this.#internal, ASF_DEFAULT_RIPPLE, false),
    )
  }

  /**
   * Toggle the `asfRequireAuth` flag. When enabled, holders cannot hold
   * a balance of this wallet's tokens until the wallet calls
   * {@link Wallet.authorize} for them.
   *
   * Note: cannot be enabled if the issuer already has trustlines.
   */
  async requireAuthorization(
    value: boolean,
    options: NetworkOptions = {},
  ): Promise<{ hash: string }> {
    return this.#submit(options, (client) =>
      setAccountFlag(client, this.#internal, ASF_REQUIRE_AUTH, value),
    )
  }

  /**
   * Permanently allow this wallet to claw back its own tokens
   * (`asfAllowTrustlineClawback`). Once set, this flag cannot be cleared.
   */
  async allowClawback(options: NetworkOptions = {}): Promise<{ hash: string }> {
    return this.#submit(options, (client) =>
      setAccountFlag(client, this.#internal, ASF_ALLOW_TRUSTLINE_CLAWBACK, true),
    )
  }

  /**
   * As issuer, authorise a holder's trustline. Only meaningful when this
   * wallet has {@link Wallet.requireAuthorization} enabled.
   */
  async authorize(
    holder: string,
    currency: IssuedCurrency,
    options: NetworkOptions = {},
  ): Promise<{ hash: string }> {
    return this.#submit(options, (client) =>
      authorizeTrustline(client, this.#internal, holder, currency),
    )
  }

  /** As issuer, freeze a specific holder's trustline. */
  async freeze(
    holder: string,
    currency: IssuedCurrency,
    options: NetworkOptions = {},
  ): Promise<{ hash: string }> {
    return this.#submit(options, (client) =>
      setIssuerFreeze(client, this.#internal, holder, currency, true),
    )
  }

  /** As issuer, unfreeze a holder's trustline previously frozen via {@link Wallet.freeze}. */
  async unfreeze(
    holder: string,
    currency: IssuedCurrency,
    options: NetworkOptions = {},
  ): Promise<{ hash: string }> {
    return this.#submit(options, (client) =>
      setIssuerFreeze(client, this.#internal, holder, currency, false),
    )
  }

  /**
   * As issuer, pull `amount` of `currency` back from `from`. Requires
   * {@link Wallet.allowClawback} to have been set on this wallet first.
   */
  async clawback(
    from: string,
    amount: string,
    currency: IssuedCurrency,
    options: NetworkOptions = {},
  ): Promise<{ hash: string }> {
    return this.#submit(options, (client) =>
      clawbackTokens(client, this.#internal, from, amount, currency),
    )
  }

  /**
   * As issuer, credit `to` with `amount` of `currency` (the issuer must be
   * this wallet). The recipient must have already accepted the token via
   * {@link Wallet.acceptToken} -- XRPL requires the holder to consent
   * before a balance can land on their account.
   */
  async issue(
    to: string,
    amount: string,
    currency: IssuedCurrency,
    options: NetworkOptions = {},
  ): Promise<{ hash: string }> {
    return this.#submit(options, (client) =>
      issuePayment(client, this.#internal, to, amount, currency),
    )
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

/**
 * Open a short-lived xrpl.js Client, run `fn`, and disconnect on exit. Shared
 * by every Wallet method that hits the ledger so connection lifecycle stays
 * in one place.
 */
async function withClient<T>(
  options: NetworkOptions,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const network = options.network ?? 'testnet'
  const rpcUrl = options.rpcUrl ?? XRPL_RPC_URLS[network]
  const client = new Client(rpcUrl)
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.disconnect()
  }
}
