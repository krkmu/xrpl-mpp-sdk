/**
 * Wallet abstraction for the XRPL MPP SDK.
 *
 * Wraps the underlying xrpl.js {@link XrplWallet} so consumers never need to
 * import from `xrpl` directly. Exposes:
 * - construction from seed, random generation, faucet funding,
 * - the public fields needed to sign and identify the holder,
 * - PayChannel claim signing (drops in -> hex signature out),
 * - token-level operations (accept / refuse, transfer, issue, freeze,
 *   authorize, clawback, ...) that hide every TrustSet / MPTokenAuthorize
 *   / MPTokenIssuanceCreate detail. The methods are polymorphic over
 *   {@link IssuedCurrency} | {@link MPToken}: the SDK dispatches to the
 *   right XRPL object internally.
 */

import { Client, dropsToXrp, signPaymentChannelClaim, Wallet as XrplWallet } from 'xrpl'
import { type NetworkId, XRPL_RPC_URLS } from '../constants.js'
import type {
  AcceptTokenResult,
  CreateTokenOptions,
  CreateTokenResult,
  IssuedCurrency,
  MPTHoldingInfo,
  MPTIssuanceInfo,
  MPToken,
  RefuseTokenResult,
  TokenHolding,
} from '../types.js'
import { isMPT } from './currency.js'
import {
  authorizeMPTHolder,
  clawbackMPT,
  createMPTIssuance,
  destroyMPTIssuance,
  getMPTHolding,
  issueMPTPayment,
  listMPTHoldings,
  listMPTIssuances,
  removeMPTHolding,
  setMPTHolderLock,
  setMPTHolding,
  setMPTIssuanceLock,
} from './mpt.js'
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

/**
 * Options for token-level holder operations on Wallet.
 *
 * The trustline-specific keys (`limit`, `noRipple`) are silently ignored when
 * the currency is an MPT -- MPT semantics don't expose either knob.
 */
export type TokenOptions = NetworkOptions & SetTrustlineOptions

/** Either kind of issued asset accepted by the polymorphic Wallet methods. */
export type Token = IssuedCurrency | MPToken

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
   * Opt in to receive a token. For an IOU this creates (or updates) the
   * trustline; for an MPT this submits the holder-side `MPTokenAuthorize`.
   *
   * Idempotent: returns `unchanged` when the holding already exists in the
   * desired state. Returns `pending_authorization` when the issuer has
   * `requireAuthorization` and has not yet signed -- the holder side is in
   * place but cannot hold a balance until the issuer calls
   * {@link Wallet.authorize} from their side.
   *
   * The `limit` / `noRipple` options of {@link TokenOptions} apply to IOUs
   * only; they are silently ignored for MPT.
   */
  async acceptToken(token: Token, options: TokenOptions = {}): Promise<AcceptTokenResult> {
    if (isMPT(token)) {
      return this.#submit(options, (client) => setMPTHolding(client, this.#internal, token))
    }
    return this.#submit(options, (client) =>
      setTrustline(client, this.#internal, token, {
        ...(options.limit !== undefined ? { limit: options.limit } : {}),
        ...(options.noRipple !== undefined ? { noRipple: options.noRipple } : {}),
      }),
    )
  }

  /**
   * Stop holding a token. Refuses to submit if the holding still has a
   * non-zero balance (send the balance back to the issuer first, or have
   * the issuer claw it back).
   *
   * For IOUs the result distinguishes `removed` (trustline deleted, owner
   * reserve freed) from `cleared` (TrustSet succeeded but a non-default
   * flag keeps the entry pinned). For MPTs only `absent` / `removed` apply.
   */
  async refuseToken(token: Token, options: NetworkOptions = {}): Promise<RefuseTokenResult> {
    if (isMPT(token)) {
      return this.#submit(options, (client) => removeMPTHolding(client, this.#internal, token))
    }
    return this.#submit(options, (client) => removeTrustline(client, this.#internal, token))
  }

  /** Read this wallet's current state for a given token. Returns null if not held. */
  async holdsToken(
    token: Token,
    options: NetworkOptions = {},
  ): Promise<TrustlineInfo | MPTHoldingInfo | null> {
    if (isMPT(token)) {
      return withClient(options, (client) => getMPTHolding(client, this.address, token))
    }
    return withClient(options, (client) => getTrustline(client, this.address, token))
  }

  /**
   * List every token (IOU and MPT) this wallet has accepted. Each entry is
   * tagged with `kind: 'iou' | 'mpt'` so consumers can narrow without a
   * separate type guard.
   *
   * Performs two RPC round-trips in parallel (`account_lines` for IOUs and
   * `account_objects type=mptoken` for MPTs).
   */
  async listAcceptedTokens(options: NetworkOptions = {}): Promise<TokenHolding[]> {
    return withClient(options, async (client) => {
      const [trustlines, mpts] = await Promise.all([
        listTrustlines(client, this.address),
        listMPTHoldings(client, this.address),
      ])
      const iouEntries: TokenHolding[] = trustlines.map((t) => ({ kind: 'iou' as const, ...t }))
      const mptEntries: TokenHolding[] = mpts.map((m) => ({ kind: 'mpt' as const, ...m }))
      return [...iouEntries, ...mptEntries]
    })
  }

  // ===== Issuer operations =====

  /**
   * Allow this wallet's IOU to flow through intermediary accounts
   * (`asfDefaultRipple`). Required by anyone who acts as an issuer of an
   * IOU -- without it, holders of the token cannot pay each other through
   * the issuer.
   *
   * MPT-only note: this flag has no MPT counterpart -- MPT transfers are
   * gated by the immutable `allowTransfer` flag set at create time.
   */
  async enableTransfers(options: NetworkOptions = {}): Promise<{ hash: string }> {
    return this.#submit(options, (client) =>
      setAccountFlag(client, this.#internal, ASF_DEFAULT_RIPPLE, true),
    )
  }

  /** Inverse of {@link Wallet.enableTransfers}. IOU only. */
  async disableTransfers(options: NetworkOptions = {}): Promise<{ hash: string }> {
    return this.#submit(options, (client) =>
      setAccountFlag(client, this.#internal, ASF_DEFAULT_RIPPLE, false),
    )
  }

  /**
   * Toggle the `asfRequireAuth` flag for IOUs. When enabled, holders cannot
   * hold a balance of this wallet's IOUs until the wallet calls
   * {@link Wallet.authorize} for them.
   *
   * MPT note: the equivalent flag (`tfMPTRequireAuth`) is **immutable** and
   * is set only at create time -- pass `requireAuthorization: true` to
   * {@link Wallet.createToken} instead.
   *
   * Cannot be enabled on an IOU issuer that already has trustlines.
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
   * Permanently allow this wallet to claw back its own IOUs
   * (`asfAllowTrustlineClawback`). Once set, this flag cannot be cleared.
   *
   * MPT note: clawback for an MPT is gated by the immutable `allowClawback`
   * flag of the MPTokenIssuance. Pass `allowClawback: true` to
   * {@link Wallet.createToken} instead.
   */
  async allowClawback(options: NetworkOptions = {}): Promise<{ hash: string }> {
    return this.#submit(options, (client) =>
      setAccountFlag(client, this.#internal, ASF_ALLOW_TRUSTLINE_CLAWBACK, true),
    )
  }

  /**
   * As issuer, authorise a holder. For an IOU this is a `TrustSet`
   * carrying `tfSetfAuth` (only meaningful when this wallet has
   * {@link Wallet.requireAuthorization} enabled). For an MPT this is an
   * issuer-side `MPTokenAuthorize` carrying the `Holder` field (only
   * meaningful when the issuance has `requireAuthorization`).
   */
  async authorize(
    holder: string,
    token: Token,
    options: NetworkOptions = {},
  ): Promise<{ hash: string }> {
    if (isMPT(token)) {
      return this.#submit(options, (client) =>
        authorizeMPTHolder(client, this.#internal, holder, token),
      )
    }
    return this.#submit(options, (client) =>
      authorizeTrustline(client, this.#internal, holder, token),
    )
  }

  /**
   * As issuer, freeze a specific holder. For an IOU this is a `TrustSet`
   * carrying `tfSetFreeze`. For an MPT this is an `MPTokenIssuanceSet`
   * carrying the `Holder` field and `tfMPTLock`.
   *
   * MPT precondition: the issuance must have been created with
   * `allowLock: true`. Otherwise this throws `MPT_LOCK_NOT_ALLOWED` -- the
   * flag is immutable so the only fix is to mint a new issuance.
   */
  async freeze(
    holder: string,
    token: Token,
    options: NetworkOptions = {},
  ): Promise<{ hash: string }> {
    if (isMPT(token)) {
      return this.#submit(options, (client) =>
        setMPTHolderLock(client, this.#internal, holder, token, true),
      )
    }
    return this.#submit(options, (client) =>
      setIssuerFreeze(client, this.#internal, holder, token, true),
    )
  }

  /** As issuer, unfreeze a holder previously frozen via {@link Wallet.freeze}. */
  async unfreeze(
    holder: string,
    token: Token,
    options: NetworkOptions = {},
  ): Promise<{ hash: string }> {
    if (isMPT(token)) {
      return this.#submit(options, (client) =>
        setMPTHolderLock(client, this.#internal, holder, token, false),
      )
    }
    return this.#submit(options, (client) =>
      setIssuerFreeze(client, this.#internal, holder, token, false),
    )
  }

  /**
   * As issuer, pull `amount` of the token back from `from`.
   *
   * IOU precondition: {@link Wallet.allowClawback} must have been called.
   * MPT precondition: the issuance must have been created with
   * `allowClawback: true`. Otherwise this throws `MPT_CLAWBACK_NOT_ALLOWED`.
   */
  async clawback(
    from: string,
    amount: string,
    token: Token,
    options: NetworkOptions = {},
  ): Promise<{ hash: string }> {
    if (isMPT(token)) {
      return this.#submit(options, (client) =>
        clawbackMPT(client, this.#internal, from, amount, token),
      )
    }
    return this.#submit(options, (client) =>
      clawbackTokens(client, this.#internal, from, amount, token),
    )
  }

  /**
   * As issuer, credit `to` with `amount` of `token`. The recipient must have
   * already accepted the token via {@link Wallet.acceptToken} -- XRPL
   * requires the holder to consent before a balance can land on their
   * account.
   *
   * For IOUs the issuer must equal `token.issuer`; for MPTs it must equal
   * the issuer recorded on the MPTokenIssuance.
   */
  async issue(
    to: string,
    amount: string,
    token: Token,
    options: NetworkOptions = {},
  ): Promise<{ hash: string }> {
    if (isMPT(token)) {
      return this.#submit(options, (client) =>
        issueMPTPayment(client, this.#internal, to, amount, token),
      )
    }
    return this.#submit(options, (client) =>
      issuePayment(client, this.#internal, to, amount, token),
    )
  }

  // ===== MPT-only lifecycle =====

  /**
   * Create a new MPT issuance. Returns the freshly minted {@link MPToken}
   * handle plus the submission hash.
   *
   * Most flags are **immutable** once the issuance is created -- pick
   * `allowLock`, `allowClawback`, `allowTransfer`, `allowEscrow`,
   * `allowTrade`, `requireAuthorization` carefully.
   */
  async createToken(options: CreateTokenOptions & NetworkOptions = {}): Promise<CreateTokenResult> {
    return this.#submit(options, (client) => createMPTIssuance(client, this.#internal, options))
  }

  /**
   * Destroy an MPT issuance owned by this wallet. Refuses if there is any
   * outstanding supply -- claw back or burn first.
   */
  async destroyToken(mpt: MPToken, options: NetworkOptions = {}): Promise<{ hash: string }> {
    return this.#submit(options, (client) => destroyMPTIssuance(client, this.#internal, mpt))
  }

  /**
   * Lock the entire issuance: every holder is frozen at once until
   * {@link Wallet.unlockToken}. Requires the issuance to have been created
   * with `allowLock: true`.
   */
  async lockToken(mpt: MPToken, options: NetworkOptions = {}): Promise<{ hash: string }> {
    return this.#submit(options, (client) => setMPTIssuanceLock(client, this.#internal, mpt, true))
  }

  /** Inverse of {@link Wallet.lockToken}. */
  async unlockToken(mpt: MPToken, options: NetworkOptions = {}): Promise<{ hash: string }> {
    return this.#submit(options, (client) => setMPTIssuanceLock(client, this.#internal, mpt, false))
  }

  /** List every MPT issuance this wallet has created. */
  async listIssuedTokens(options: NetworkOptions = {}): Promise<MPTIssuanceInfo[]> {
    return withClient(options, (client) => listMPTIssuances(client, this.address))
  }

  // ===== Account state =====

  /**
   * Read the wallet's current XRP balance, in drops. Returns `'0'` when the
   * account has not been activated on the ledger yet (i.e. `actNotFound`).
   *
   * Use {@link Methods.fromDrops} to format as XRP if needed.
   */
  async getXrpBalance(options: NetworkOptions = {}): Promise<string> {
    return withClient(options, async (client) => {
      try {
        const r = await client.request({ command: 'account_info', account: this.address })
        return (r.result.account_data.Balance as string) ?? '0'
      } catch (err: any) {
        if (err?.data?.error === 'actNotFound') return '0'
        throw err
      }
    })
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
