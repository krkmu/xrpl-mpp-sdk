# xrpl-mpp-sdk

XRP Ledger payment method for the [Machine Payments Protocol (MPP)](https://mpp.dev). Extends [mppx](https://github.com/wevm/mppx) with on-chain payments (XRP, IOUs, MPTs) and off-chain micropayments via PayChannels.

## ⚠️ Disclaimer

This code is provided **as is**, it's a prototype. It has **not been audited**, there is **no
guarantee that it will be maintained**, and it should be considered **for
test and educational purposes only** — **not for Mainnet** or any
deployment that handles real value. Forking and adapting it is encouraged;
running it unmodified against live funds is not.

## Payment modes

### Charge (on-chain transfers)

Each payment settles as an XRP Ledger Payment transaction.

```
Client                          Server
  |                               |
  |  GET /resource                |
  |------------------------------>|
  |                               |
  |  402 Payment Required         |
  |  (challenge: pay 1 XRP)       |
  |<------------------------------|
  |                               |
  |  Sign Payment tx              |
  |  Send credential              |
  |------------------------------>|
  |                               |
  |  Submit to ledger, return     |
  |  data + Payment-Receipt       |
  |<------------------------------|
```

Two credential modes:

- **Pull** (default) -- client signs the transaction blob, server submits it to the ledger
- **Push** -- client submits the transaction itself, sends the tx hash for server verification

Supports three currency types:
- **XRP** -- native drops (e.g., "1000000" = 1 XRP)
- **IOU** -- issued currencies ({currency, issuer, value})
- **MPT** -- multi-purpose tokens ({mpt_issuance_id, value})

### Channel (off-chain PayChannel claims)

Uses XRP Ledger [PayChannels](https://xrpl.org/payment-channels.html). The funder deposits XRP into a channel once, then makes many off-chain payments by signing cumulative claims -- no per-payment on-chain transactions.

```
Client (Funder)                 Server (Recipient)
  |                               |
  |  [PaymentChannelCreate        |
  |   10 XRP on-chain]            |
  |                               |
  |  GET /resource                |
  |------------------------------>|
  |                               |
  |  402 (pay 0.1 XRP via         |
  |   channel, cumulative: 0)     |
  |<------------------------------|
  |                               |
  |  Sign claim (cum: 100000)     |
  |------------------------------>|
  |                               |
  |  Verify signature, 200 OK     |
  |<------------------------------|
  |                               |
  |  GET /resource (again)        |
  |------------------------------>|
  |                               |
  |  402 (cumulative: 100000)     |
  |<------------------------------|
  |                               |
  |  Sign claim (cum: 200000)     |
  |------------------------------>|
  |                               |
  |  Verify, 200 OK               |
  |<------------------------------|
  |                               |
  |  [PaymentChannelClaim         |
  |   tfClose on-chain]           |
```

PayChannels are XRP-only (denominated in drops). Both ed25519 and secp256k1 wallets are supported -- xrpl.js handles curve detection transparently.

Three credential actions:
- **open** -- client sends a signed PaymentChannelCreate tx blob; server broadcasts it, extracts the channelId, and initializes cumulative tracking
- **voucher** -- off-chain cumulative claim (default)
- **close** -- treated as a final voucher; actual channel close is done via the standalone `close()` function or by the client directly on-chain

## Install

```bash
git clone <repo-url>
cd xrpl-mpp-sdk
pnpm install
pnpm build
```

## Quick start

### Server (charge)

Charge configuration splits across two call sites: the **method instance**, registered once at startup, and the **per-request invocation**, called at the 402 point for each protected route.

```ts
import { Mppx, Store } from 'mppx/server'
import { charge } from 'xrpl-mpp-sdk/server'

// ── Method instance (set up once) ───────────────────────────────────────
// recipient, currency (default), network, store, autoTrustline, etc. are
// captured here. They apply to every charge that goes through this method.
const mppx = Mppx.create({
  secretKey: process.env.MPP_SECRET_KEY,
  methods: [
    charge({
      recipient: 'rYourAddress...',
      network: 'testnet',
      store: Store.memory(),
    }),
  ],
})

// Works with any HTTP framework. Three equivalent typed call shapes:
//   mppx['xrpl/charge'](...)  -- explicit name/intent key
//   mppx.charge(...)          -- shorthand (only when the intent is unique across methods)
//   mppx.xrpl.charge(...)     -- nested by name
export async function handler(request: Request) {
  // ── Per-request (set per protected route) ─────────────────────────────
  // amount has no default and must be supplied here. currency and any
  // methodDetails passed here override the method-instance defaults.
  const result = await mppx['xrpl/charge']({
    amount: '1000000',
    currency: 'XRP',
  })(request)

  if (result.status === 402) return result.challenge
  return result.withReceipt(Response.json({ data: 'paid content' }))
}
```

### Client (charge)

```ts
import { Mppx } from 'mppx/client'
import { charge } from 'xrpl-mpp-sdk/client'

// Patches globalThis.fetch -- 402 responses handled automatically
Mppx.create({
  methods: [
    charge({ seed: 'sEdV...', mode: 'pull', network: 'testnet' }),
  ],
})

const response = await fetch('https://api.example.com/resource')
const data = await response.json()
```

### Server (channel)

```ts
import { Mppx, Store } from 'mppx/server'
import { channel } from 'xrpl-mpp-sdk/channel/server'

const mppx = Mppx.create({
  secretKey: process.env.MPP_SECRET_KEY,
  methods: [
    channel({
      publicKey: 'ED...',      // channel funder's public key
      network: 'testnet',
      store: Store.memory(),   // tracks cumulative amounts
    }),
  ],
})
```

### Client (channel)

```ts
import { Mppx } from 'mppx/client'
import { channel } from 'xrpl-mpp-sdk/channel/client'

Mppx.create({
  methods: [
    channel({ seed: 'sEdV...', network: 'testnet' }),
  ],
})

const response = await fetch('https://api.example.com/resource')
```

## API

### Exports

| Path | Exports |
|---|---|
| `xrpl-mpp-sdk` | Methods, ChannelMethods, constants, toDrops, fromDrops, error helpers, types |
| `xrpl-mpp-sdk/client` | charge, xrpl, Mppx |
| `xrpl-mpp-sdk/server` | charge, xrpl, Mppx, Store, Expires |
| `xrpl-mpp-sdk/channel` | channel (schema), ChannelStream, ChannelSession |
| `xrpl-mpp-sdk/channel/client` | channel, openChannel, fundChannel, xrpl, Mppx |
| `xrpl-mpp-sdk/channel/server` | channel, close, ChannelDisputeState, xrpl, Mppx, Store, Expires |

### Server options (charge)

Charge has two distinct call sites:

- **Method-instance config** (`charge({ ... })`, listed below): set once when registering the method with `Mppx.create()`. Applies to every charge handled by this instance: which account receives funds, which network, which store backs replay protection, whether to auto-create trustlines or MPT auths, etc. These are not changeable per-request.
- **Per-request invocation** (`mppx['xrpl/charge']({ amount, currency?, methodDetails? })`): called at each 402 point. The `amount` has no default and must be supplied here; everything else (`currency`, `methodDetails`) overrides the method-instance default if specified, or falls back to it if omitted (mppx's standard `defaults` precedence -- per-call wins).

```ts
charge({
  recipient: string,                // XRPL classic address (r...)
  currency?: XrplCurrency,          // default: 'XRP'. Also: {currency, issuer} or {mpt_issuance_id}.
                                    // Per-request currency on mppx['xrpl/charge']({...}) overrides.
  network?: 'mainnet' | 'testnet' | 'devnet',  // default: 'testnet'
  rpcUrl?: string,                  // custom WebSocket RPC URL
  store?: Store.Store,              // required by default for replay protection (see requireStore)
  requireStore?: boolean,           // require store for replay protection (default: true)
  autoTrustline?: boolean,          // auto-create TrustSet on recipient for IOUs (default: false)
  autoTrustlineLimit?: string,      // max balance willing to hold from issuer (default: '10000')
  autoMPTAuthorize?: boolean,       // auto MPTokenAuthorize on recipient for MPTs (default: false)
  seed?: string,                    // recipient wallet seed -- required if autoTrustline or autoMPTAuthorize
  maxChallengeAge?: number,         // max challenge age in ms (default: 300_000 = 5 min, 0 disables)
  maxCredentialSize?: number,       // max credential size in bytes (default: 65_536 = 64KB, 0 disables)
  pollTimeout?: number,             // tx validation polling timeout in ms (default: 60_000)
  pollInterval?: number,            // tx validation polling interval in ms (default: 1_000)
})
```

### Client options (charge)

```ts
charge({
  seed: string,                     // wallet seed (sEdV... or s...)
  mode?: 'pull' | 'push',          // default: 'pull'
  network?: 'mainnet' | 'testnet' | 'devnet',
  rpcUrl?: string,
  preflight?: boolean,              // balance, reserves, destination, rippling (default: true)
  slippageBps?: number,             // SendMax buffer for IOU payments, 0-1000 (default: 50 = 0.5%)
  pathFindRetryDelaysMs?: number[], // ripple_path_find retry backoff (default: [1000, 2000, 4000])
  onProgress?: (event) => void,     // lifecycle callback (challenge, preflight, pathfinding, paths_resolved, signing, signed, submitting, confirmed)
})
```

### Server options (channel)

```ts
channel({
  publicKey: string,                // channel funder's public key (ED... or 02.../03...)
  network?: 'mainnet' | 'testnet' | 'devnet',
  rpcUrl?: string,
  store?: Store.Store,              // required by default for cumulative tracking + replay protection
  requireStore?: boolean,           // require store (default: true)
  maxChallengeAge?: number,         // max challenge age in ms (default: 300_000 = 5 min, 0 disables)
  verifyChannelOnChain?: boolean,   // verify channel exists, expiration, balance on-chain (default: true)
  channelMetadataTtlMs?: number,    // cache TTL for channel metadata in ms (default: 60_000, 0 disables)
  channelLookup?: ChannelLookup,    // override the on-chain lookup (test injection, custom transport)
  onDisputeDetected?: (state) => void, // called when unilateral close detected on-chain (CancelAfter set)
})
```

When `verifyChannelOnChain` is on (the default), the first voucher per channel costs one `ledger_entry` RPC; subsequent vouchers reuse cached `Amount`/`Expiration`/`CancelAfter` until `channelMetadataTtlMs` elapses or the cumulative exceeds the cached `Amount` (force-refresh detects a `PaymentChannelFund` top-up). Without it, the server accepts any cryptographically-valid claim for any channelId, including fabricated ones.

### Client options (channel)

```ts
channel({
  seed: string,                     // channel funder's wallet seed
  network?: 'mainnet' | 'testnet' | 'devnet',
  rpcUrl?: string,
})
```

### Currency formats

```ts
// XRP native (amount in drops)
{ amount: '1000000', currency: 'XRP' }

// IOU -- issued currency
{ amount: '10', currency: '{"currency":"USD","issuer":"rIssuer..."}' }

// MPT -- multi-purpose token
{ amount: '100', currency: '{"mpt_issuance_id":"00ABC..."}' }
```

### Tags, InvoiceID, and memos

`methodDetails` is a per-request field passed at the 402 point (not on the method instance), so its values can vary per protected route. The server attaches these to the challenge; the client puts them on the Payment tx; the server enforces them on verify. A client who omits a required `DestinationTag` (or sends a different one) is rejected with `SUBMISSION_FAILED`.

```ts
// Per-request -- bind a particular charge to additional Payment fields
const result = await mppx['xrpl/charge']({
  amount: '1000000',
  currency: 'XRP',
  methodDetails: {
    invoiceId: '0123...64-hex...',          // 32-byte InvoiceID, hex
    destinationTag: 12345,                   // routes to a hosted-wallet user
    sourceTag: 7,                            // optional, mirrors destinationTag
    memos: [                                 // UTF-8, hex-encoded by the SDK
      { type: 'reconciliation-id', data: 'order-42' },
    ],
  },
})(request)
```

### Cross-issuer IOU payments

The SDK auto-resolves IOU paths. When the sender holds one issuer's IOU and the recipient holds a different issuer's IOU, the client calls `ripple_path_find` before signing, picks the cheapest alternative, and attaches `Paths` and `SendMax` to the Payment. The issuer's `TransferRate` is read from `account_info` and factored into `SendMax`. The default slippage buffer is 50 bps (0.5%), tunable via `slippageBps` (range 0-1000). Same-issuer payments and self-issued IOUs skip path-find. See [`demo/iou-cross-issuer.ts`](demo/iou-cross-issuer.ts) for a runnable end-to-end example.

```ts
import { Mppx } from 'mppx/client'
import { charge } from 'xrpl-mpp-sdk/client'

const mppx = Mppx.create({
  methods: [
    charge({
      seed: 'sEdV...',          // sender holds USD.IssuerA
      slippageBps: 50,           // 0.5% buffer (default)
      onProgress: (e) => e.type === 'paths_resolved' && console.log(e.strategy, e.sourceAmountValue),
    }),
  ],
})

// Server's challenge specifies USD.IssuerB. The SDK routes through whatever
// liquidity exists from sender's USD.IssuerA holdings to recipient's
// USD.IssuerB trustline -- no manual path construction.
const res = await mppx.fetch('https://example.com/resource')
```

### Opening and closing channels

```ts
import { openChannel, fundChannel } from 'xrpl-mpp-sdk/channel/client'
import { close } from 'xrpl-mpp-sdk/channel/server'

// Open a channel (on-chain)
const { channelId, txHash } = await openChannel({
  seed: 'sEdV...',
  destination: 'rRecipient...',
  amount: '10000000',       // 10 XRP in drops
  settleDelay: 3600,        // 1 hour
})

// Fund an existing channel (on-chain)
await fundChannel({ seed: 'sEdV...', channelId, amount: '5000000' })

// Close a channel (on-chain) -- typically called by the client (funder)
await close({
  seed: 'sEdV...',
  channelId,
  amount: '500000',         // cumulative drops to settle
  signature: '...',         // claim signature
  channelPublicKey: 'ED...', // channel source public key
})
```

**Server-side redeem:** The server stores the latest claim signature alongside the cumulative amount. If the client disappears without closing the channel, the server can call `close()` with its own seed to redeem accumulated funds on-chain. The server's `close()` call submits a `PaymentChannelClaim` without `tfClose` (only the channel source can close). To enable this, the server operator needs access to the recipient wallet seed.

### Streaming and sessions

```ts
import { ChannelStream, ChannelSession } from 'xrpl-mpp-sdk/channel'

// Pay-per-token streaming
const stream = new ChannelStream({
  channelId: '...',
  privateKey: wallet.privateKey,
  dropsPerUnit: '100',      // 100 drops per token
  granularity: 10,          // sign every 10 tokens
})

const claim = stream.tick(1) // returns ChannelClaim | null
const final = stream.sign()  // force-sign current state

// Session billing (N requests)
const session = new ChannelSession({
  channelId: '...',
  privateKey: wallet.privateKey,
  dropsPerRequest: '10000',
})

session.pay()                // returns ChannelClaim | null
session.settle()             // force-sign for settlement
```

### Replay protection and source binding

Provide an mppx `Store` to prevent credential reuse:

```ts
import { Store } from 'xrpl-mpp-sdk/server'

charge({
  recipient: 'r...',
  store: Store.memory(),     // or Store.upstash(), Store.cloudflare()
})
```

The server keys off the challenge ID, the transaction hash (charge), and the `xrpl:channel:{channelId}` cumulative state (channel). The default config requires a store; pass `requireStore: false` to opt out (not recommended).

The server also binds every credential to its issuer DID. The credential's `source` field is parsed as `did:pkh:xrpl:{network}:{address}` and the embedded address is matched against:

- For charge: `tx.Account` on the submitted Payment.
- For channel voucher/close: the address derived from the configured `publicKey`.
- For channel open: `decoded.Account` on the PaymentChannelCreate.

This closes hash-theft (push mode) and third-party-blob replay (pull mode) -- an attacker cannot wrap a third party's tx hash or signed blob in their own credential and claim credit. Mismatches surface as `SOURCE_MISMATCH`.

For charge: deduplicates challenge IDs and transaction hashes.
For channels: enforces strict cumulative monotonicity (new > previous), rejects fabricated channelIds via on-chain verification, and emits `CHANNEL_EXHAUSTED` when cumulative exceeds the funded `Amount` (with one force-refresh to detect a `PaymentChannelFund` top-up).

### Owner-reserve preflight

Operations that add an owner object (`TrustSet`, `MPTokenAuthorize`, `PaymentChannelCreate`) run a reserve preflight before submitting. The check reads `server_state` for the current base + per-object reserve, factors in the wallet's existing `OwnerCount`, and asserts the wallet can cover the new floor plus fee plus payment. Failures surface as `INSUFFICIENT_RESERVE` or `INSUFFICIENT_BALANCE` with an actionable message naming the operation kind, instead of letting the raw `tecINSUFFICIENT_RESERVE` bubble up.

### Key types

Both ed25519 and secp256k1 wallets work for all operations. xrpl.js detects the key type from the public key prefix:
- `ED` prefix -- ed25519
- `02`/`03` prefix -- secp256k1

No configuration needed -- the SDK passes keys through to xrpl.js which handles both curves transparently.

## Error mapping

XRPL transaction engine results are mapped to MPP error types (RFC 9457 Problem Details):

| tecResult | SDK Code | MPP Error Type |
|---|---|---|
| `tecPATH_DRY` | `PAYMENT_PATH_FAILED` | VerificationFailedError |
| `tecPATH_PARTIAL` | `PAYMENT_PATH_FAILED` | VerificationFailedError |
| `tecUNFUNDED_PAYMENT` | `INSUFFICIENT_BALANCE` | InsufficientBalanceError |
| `tecNO_DST` | `RECIPIENT_NOT_FOUND` | VerificationFailedError |
| `tecNO_AUTH` | `TRUSTLINE_NOT_AUTHORIZED` | VerificationFailedError |
| `tecNO_LINE` | `MISSING_TRUSTLINE` | VerificationFailedError |
| `tecNO_LINE_INSUF_RESERVE` | `INSUFFICIENT_RESERVE` | VerificationFailedError |
| `tecNO_LINE_REDUNDANT` | `MISSING_TRUSTLINE` | VerificationFailedError |
| `tecFROZEN` | `TRUSTLINE_FROZEN` | VerificationFailedError |
| `tecINSUFFICIENT_RESERVE` | `INSUFFICIENT_RESERVE` | VerificationFailedError |
| `tecINSUFF_FEE` | `INSUFFICIENT_FEE` | VerificationFailedError |
| `terINSUF_FEE_B` | `INSUFFICIENT_FEE` | VerificationFailedError |
| `tecNO_PERMISSION` | `MPT_NOT_AUTHORIZED` | VerificationFailedError |
| `temBAD_AMOUNT` | `INVALID_AMOUNT` | VerificationFailedError |
| `tefPAST_SEQ` | `SUBMISSION_FAILED` | VerificationFailedError |
| `tefALREADY` | `SUBMISSION_FAILED` | VerificationFailedError |
| `tefBAD_AUTH` | `INVALID_SIGNATURE` | VerificationFailedError |
| `tefMASTER_DISABLED` | `INVALID_SIGNATURE` | VerificationFailedError |

Additional SDK-level error codes (raised before submit, no tecResult):
- `SOURCE_MISMATCH` -- VerificationFailedError, the on-chain payer or channel funder does not match the credential's `did:pkh:xrpl:...` source
- `RECIPIENT_MISMATCH` -- VerificationFailedError, the tx Destination does not match the challenge recipient
- `AMOUNT_MISMATCH` -- VerificationFailedError, the delivered amount does not equal the challenge amount
- `ISSUER_GLOBAL_FROZEN` -- raised by trustline preflight when the issuer has `lsfGlobalFreeze`
- `TRUSTLINE_REQUIRES_AUTH` -- raised after a TrustSet against an issuer with `asfRequireAuth`; the trustline exists but cannot hold balance until the issuer authorizes it
- `MPT_NOT_AUTHORIZED` (no holding) -- raised when no MPToken object exists and `autoMPTAuthorize` is false
- `MPT_NOT_AUTHORIZED` (issuer side) -- raised after holder-side authorization when the issuance has `lsfMPTRequireAuth` and the issuer must run a paired MPTokenAuthorize

Channel-specific:
- `INVALID_SIGNATURE` -- InvalidSignatureError, claim signature does not verify against the configured `publicKey`
- `REPLAY_DETECTED` -- VerificationFailedError, same cumulative resubmitted or challenge id reused
- `CHANNEL_NOT_FOUND` -- ChannelNotFoundError (410)
- `CHANNEL_EXPIRED` -- ChannelClosedError (410), `Expiration` elapsed or channel finalized
- `CHANNEL_EXHAUSTED` -- AmountExceedsDepositError, cumulative exceeds the channel's funded `Amount` even after a force-refresh

All errors extend mppx's `PaymentError` base class and serialize to RFC 9457 Problem Details format.

## Constants

| Constant | Value |
|---|---|
| `XRPL_RPC_URLS.mainnet` | `wss://xrplcluster.com` |
| `XRPL_RPC_URLS.testnet` | `wss://s.altnet.rippletest.net:51233` |
| `XRPL_RPC_URLS.devnet`  | `wss://s.devnet.rippletest.net:51233` |
| `XRPL_FAUCET_URLS.testnet` | `https://faucet.altnet.rippletest.net/accounts` |
| `XRPL_FAUCET_URLS.devnet`  | `https://faucet.devnet.rippletest.net/accounts` |
| `XRPL_EXPLORER_URLS.mainnet` | `https://xrpl.org/transactions/` |
| `XRPL_EXPLORER_URLS.testnet` | `https://testnet.xrpl.org/transactions/` |
| `XRPL_EXPLORER_URLS.devnet`  | `https://devnet.xrpl.org/transactions/` |
| `RLUSD_MAINNET` | `{ currency: 'RLUSD', issuer: 'rMxWzrBMyeKR9oJfYBrhAEGsxwsdLFSfim' }` |
| `RLUSD_TESTNET` | `{ currency: 'RLUSD', issuer: 'rQhWct2fTR9z7bBQaflfqMEr2u8avFFpKH' }` |
| `XRP_DECIMALS` | `6` |
| `BASE_RESERVE_DROPS` | `'1000000'` (1 XRP, current mainnet) |
| `OWNER_RESERVE_DROPS` | `'200000'` (0.2 XRP, current mainnet) |

The reserve constants are static fallbacks. The SDK's preflight reads live values via `server_state` so wallets stay correct after any future ledger-wide reserve change.

## Demos

Most demos run on XRPL testnet; the cross-issuer demo runs on devnet (rationale below). Zero env vars -- every script generates wallets and funds them automatically via the network's faucet. See [demo/README.md](demo/README.md) for details.

```bash
# XRP charge (two terminals)
npx tsx demo/xrp-server.ts          # Terminal 1
npx tsx demo/xrp-client.ts          # Terminal 2

# IOU charge (all-in-one: issuer + trustlines + issuance + charge)
npx tsx demo/iou-charge.ts

# Cross-issuer IOU (devnet -- faster path-find indexer; sender holds USD.A,
# recipient holds USD.B, market-maker bridges; SDK auto-resolves the path)
npx tsx demo/iou-cross-issuer.ts

# MPT charge (all-in-one: MPT issuance + authorize + charge)
npx tsx demo/mpt-charge.ts

# PayChannel (two terminals: open, 5 off-chain claims, close)
npx tsx demo/channel-server.ts      # Terminal 1
npx tsx demo/channel-client.ts      # Terminal 2

# Error showcase (13 cases, fail-fix-validate)
npx tsx demo/error-showcase.ts

# Streaming simulation (offline)
npx tsx examples/stream-llm.ts
```

The cross-issuer demo runs on devnet because public testnet's path indexer is materially slower at surfacing freshly-created orderbooks; on devnet a fresh `OfferCreate` is visible to `ripple_path_find` within seconds.

## Project structure

```
xrpl-mpp-sdk/
  sdk/src/
    index.ts                 # Root exports, constants, types, error helpers
    Methods.ts               # Charge schema (name: 'xrpl', intent: 'charge')
    constants.ts             # RPC URLs, faucet URLs, explorer URLs, well-known currencies, reserves
    types.ts                 # XrplCurrency, config types, ChargeProgressEvent
    errors.ts                # tecResult mapping, typed error constructors
    utils/
      currency.ts            # parseCurrency, buildAmount, isXrp/isIOU/isMPT
      did.ts                 # classicAddressFromDID, classicAddressFromPublicKey (source binding)
      paths.ts               # resolveIouPaymentExtras (ripple_path_find + SendMax + slippage)
      reserves.ts            # getReserveState, assertReserveCovers (owner-reserve preflight)
      trustline.ts           # ensureTrustline, checkRippling, freeze + RequireAuth detection
      mpt.ts                 # ensureMPTHolding, lsfMPTRequireAuth detection
      validation.ts          # runPreflight, assertIssuerHealth (rippling, global freeze, RequireAuth)
    client/
      Charge.ts              # Client charge: preflight, IOU path resolve, sign, push/pull
      Methods.ts             # xrpl.charge() convenience wrapper
      index.ts
    server/
      Charge.ts              # Server charge: DID source bind, validate, submit, poll
      Methods.ts
      index.ts
    channel/
      Methods.ts             # Channel schema (name: 'xrpl', intent: 'channel')
      stream.ts              # ChannelStream, ChannelSession
      index.ts
      client/
        Channel.ts           # Sign claims, openChannel (reserve preflight), fundChannel
        Methods.ts
        index.ts
      server/
        Channel.ts           # Verify claims, on-chain channel verification, cache, close()
        Methods.ts
        index.ts
  test/
    compliance/              # MPP protocol, intents, interop
    security/                # Replay, tamper, input validation, channel auth, source binding
    xrpl/                    # Charge, channel, paths, reserves, trustline freeze, MPT auth, stream, dual-curve
    integration/             # Devnet end-to-end (gated)
      devnet-helpers.ts
      charge.devnet.test.ts
      channel.devnet.test.ts
      iou-cross-issuer.devnet.test.ts
    utils/test-helpers.ts
  demo/
    log.ts                   # Shared styled terminal output utility
    xrp-server.ts            # XRP charge server (two-terminal)
    xrp-client.ts            # XRP charge client (two-terminal)
    iou-charge.ts            # Same-issuer IOU charge all-in-one
    iou-cross-issuer.ts      # Cross-issuer IOU charge (devnet, all-in-one)
    mpt-charge.ts            # MPT charge all-in-one
    channel-server.ts        # PayChannel server (two-terminal)
    channel-client.ts        # PayChannel client (two-terminal)
    error-showcase.ts        # 13 error cases, fail-fix-validate
  examples/
    server.ts                # Minimal charge server (env var config)
    client.ts                # Minimal charge client (env var config)
    channel-server.ts        # Minimal channel server (env var config)
    channel-client.ts        # Minimal channel client (env var config)
    stream-llm.ts            # Pay-per-token streaming simulation (offline)
    channel-open-mpp.ts      # Channel open via MPP 402 flow (concept example)
  vitest.config.ts            # Unit suite + coverage threshold (80% on core modules)
  vitest.integration.config.ts # Devnet integration suite (single-fork, no coverage)
  .github/workflows/ci.yml    # Two jobs: unit (every push/PR) + integration (gated)
  docs/
    audit.md                 # Module-by-module gap analysis and PR sequence
    open-flow-check.md       # Channel open placeholder-signature analysis
    security-pass.md         # Targeted private-key-handling review
    session-report.md        # Per-session change log
```

## Development

```bash
pnpm install
pnpm check:types             # TypeScript strict mode
pnpm lint                    # Biome lint + format
pnpm test                    # Unit suite (~230 tests, ~2s)
pnpm test:coverage           # Unit suite with v8 coverage (80% threshold on core modules)
pnpm test:integration        # Devnet integration suite (real ledger, faucet-funded ephemeral wallets)
pnpm build                   # tsup build to dist/
```

CI runs `unit` on every push and PR; `integration` is gated to push-to-main, PRs labelled `run-integration`, or manual `workflow_dispatch`. The integration job is informational only -- it does not block PRs because the public devnet faucet can be flaky.

## Protocol

This SDK implements the [Machine Payments Protocol (MPP)](https://mpp.dev) HTTP 402 flow as specified in [draft-httpauth-payment-00](https://github.com/tempoxyz/mpp-specs). It extends the [mppx](https://github.com/wevm/mppx) framework with XRPL-specific payment methods.

## License

MIT
