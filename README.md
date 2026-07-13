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

## AI agent template

A minimal but **real-life** end-to-end starter for AI agent integrators lives
at [`examples/agent-template`](examples/agent-template). It demonstrates an
autonomous agent (Claude with tool-use) that **discovers, pays, and consumes a
paid HTTP API** -- no API keys, no monthly invoices, no Stripe -- just a
per-call XRPL Payment settled through the MPP HTTP 402 flow.

```
+---------------------------+                  +---------------------------+
|      AI agent process     |                  |      Express server       |
|                           |                  |                           |
|  - Claude (tool-use)      |   POST           |  - holds recipient wallet |
|  - holds payer wallet     |   /linkedin-post |  - mppx-gated endpoint    |
|  - mppx patches fetch()   | ---------------> |  - calls Claude to draft  |
|                           | <- 402 (price) - |    the post once paid     |
|                           | -- sign tx ----> |                           |
|                           | <- 200 + post +  |                           |
|                           |    receipt ----- |                           |
+---------------------------+                  +---------------------------+
              \                                            /
               \           XRPL testnet (real chain)      /
                +------------------------------------------+
```

### What's wired up

- **Express marketplace server** ([`src/server.ts`](examples/agent-template/src/server.ts))
  -- holds the recipient wallet, exposes a free `GET /info` for price discovery
  and a paid `POST /linkedin-post` endpoint gated by mppx + the
  `xrpl-mpp-sdk` charge method. The server-side workload is itself a Claude
  call that drafts the post once payment is validated on-chain.
- **AI agent process** ([`src/agent.ts`](examples/agent-template/src/agent.ts))
  -- a Claude model (Haiku 4.5 by default) with one tool,
  `generate_linkedin_post`. Holds the payer wallet and signs the XRPL Payment
  transparently when the server replies `402`.
- **Paid fetch helper** ([`src/client.ts`](examples/agent-template/src/client.ts))
  -- installs mppx's fetch middleware so the agent's tool just calls `fetch()`
  and the 402 handshake is handled under the hood.
- **One-command orchestrator** ([`src/run-demo.ts`](examples/agent-template/src/run-demo.ts))
  -- spawns the server as a child process, funds ephemeral testnet wallets,
  runs the agent once with a hard-coded prompt, prints the receipt + explorer
  link, and exits cleanly.

### Prerequisites

You need an Anthropic API key (new accounts get $5 of trial credit, more than
enough for hundreds of Haiku runs of this demo):

```bash
pnpm install
cp examples/agent-template/.env.example examples/agent-template/.env
# then edit examples/agent-template/.env and paste your sk-ant-api03-... key
```

Everything else (wallets, network, pricing) has sensible testnet defaults --
ephemeral wallets are auto-funded via the faucet on each run unless you pin
seeds in `.env`.

### Option A -- run everything in one command

```bash
pnpm agent-template
```

That single command:

1. spawns `src/server.ts` as a **child process** -- it auto-funds the
   recipient wallet, boots Express on `http://localhost:3000`, and waits for
   incoming requests;
2. auto-funds the agent's payer wallet;
3. runs the Claude agent with a hard-coded "write me a LinkedIn post" request;
4. the agent decides on its own to call its tool, mppx pays the 402
   transparently on testnet, the server submits the tx, polls until validated,
   then calls Anthropic and returns the post;
5. prints the agent's final message, the generated post, and the on-chain
   receipt(s) with explorer link(s);
6. kills the server subprocess and exits.

Use this when you just want to see the full happy path once.

### Option B -- run server and agent in two terminals

This mirrors the real deployment shape (two independent processes, two
independent organisations) and lets you fire repeated paid calls against a
long-running server:

```bash
# terminal 1 -- boots the marketplace on :3000, holds the recipient wallet
pnpm agent-template:server
```

Wait for the `listening on http://localhost:3000` banner, then in another
terminal:

```bash
# terminal 2 -- run the agent once with your own prompt
pnpm agent-template:agent \
  "Write a LinkedIn post about our SDK release for MPP."
```

The agent prompt is taken from CLI args (everything after the script name is
joined and sent to Claude). The server keeps running between invocations, so
you can repeat the second command as many times as you like and watch each
XRPL Payment accumulate on the explorer.

> Server and agent run in two **separate Node processes** on purpose -- that's
> the real deployment shape, and it avoids cross-contamination of mppx's
> patched `globalThis.fetch` between client and server sides.

See [`examples/agent-template/README.md`](examples/agent-template/README.md)
for the detailed architecture diagram, env-based wallet management, production
caveats (KMS-backed signing, rate-limiting, persistent replay store), and how
to lift the folder out of the monorepo as a standalone starter project.

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
| `xrpl-mpp-sdk` | Methods, ChannelMethods, Wallet (high-level wallet API), constants (RPC/faucet/explorer URLs, `XRP`, `XRPL_NETWORK_IDS`, `XRP_DECIMALS`, `DEFAULT_TIMEOUT`, `BASE_RESERVE_DROPS`, `OWNER_RESERVE_DROPS`, `RLUSD_MAINNET`, `RLUSD_TESTNET`), toDrops, fromDrops, error helpers, types (incl. `NetworkId`, wallet/trustline option types), generatePreimageCondition |
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

### Escrows

Lock XRP (or post-`TokenEscrow` IOU/MPT) until either a time has passed or a crypto-condition is satisfied. The Wallet API exposes the full lifecycle without ever touching `xrpl.js`:

```ts
import { generatePreimageCondition, Wallet } from 'xrpl-mpp-sdk'

const creator = await Wallet.fromFaucet({ network: 'devnet' })
const recipient = await Wallet.fromFaucet({ network: 'devnet' })

// 1. Time-locked: anyone can finish after `finishAfter`.
const { sequence, escrowId } = await creator.createEscrow({
  destination: recipient.address,
  amount: '5000000', // 5 XRP, or { currency, issuer, value } / { mpt_issuance_id, value }
  finishAfter: new Date(Date.now() + 60_000),
})

// 2. Crypto-condition gated: only the holder of `fulfillment` can finish.
const { condition, fulfillment } = generatePreimageCondition()
await creator.createEscrow({
  destination: recipient.address,
  amount: '5000000',
  condition,
  cancelAfter: new Date(Date.now() + 24 * 60 * 60 * 1000),
})

// Inspect / list outstanding escrows.
const info = await creator.getEscrow({ owner: creator.address, sequence })
const all = await creator.listEscrows()

// Finish (anyone may submit -- funds always go to `Destination`).
await recipient.finishEscrow({ owner: creator.address, sequence })
// Or with a fulfillment:
// await recipient.finishEscrow({ owner: creator.address, sequence, condition, fulfillment })

// Cancel after `CancelAfter` -- refunds the creator (anyone may submit).
await creator.cancelEscrow({ owner: creator.address, sequence })
```

The SDK preflights every operation: reserve coverage on `createEscrow`, `FinishAfter` cutoff on `finishEscrow` (typed `ESCROW_NOT_READY` instead of a raw `tecNO_PERMISSION`), `CancelAfter` cutoff and "no `CancelAfter` set" on `cancelEscrow`, and on-chain condition match on the fulfillment path. Time fields accept `Date`, Unix milliseconds, or ISO-8601 strings; the SDK converts to ripple time internally and surfaces JS `Date`s on read.

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
| `tecCRYPTOCONDITION_ERROR` | `ESCROW_INVALID_FULFILLMENT` | VerificationFailedError |
| `tecNO_TARGET` | `ESCROW_NOT_FOUND` | VerificationFailedError |

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
| `RLUSD_MAINNET` | `{ currency: '524C555344...0000' (hex `RLUSD`), issuer: 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De' }` |
| `RLUSD_TESTNET` | `{ currency: '524C555344...0000' (hex `RLUSD`), issuer: 'rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV' }` |
| `XRP_DECIMALS` | `6` |
| `BASE_RESERVE_DROPS` | `'1000000'` (1 XRP, current mainnet) |
| `OWNER_RESERVE_DROPS` | `'200000'` (0.2 XRP, current mainnet) |

The reserve constants are static fallbacks. The SDK's preflight reads live values via `server_state` so wallets stay correct after any future ledger-wide reserve change.

## Demos

Every demo is self-contained: zero env vars, ephemeral wallets funded automatically via the network's faucet, single command to run. Most run on testnet; the cross-issuer one runs on devnet (rationale at the bottom of this section). See [demo/README.md](demo/README.md) for the per-demo walkthrough.

### Pick a demo by use case

| If you want to... | Run | Network |
|---|---|---|
| Charge an API in **native XRP** | `npx tsx demo/xrp-server.ts` + `npx tsx demo/xrp-client.ts` (two terminals) | testnet |
| Charge an API in a **fiat-backed token / stablecoin** (auto-trustline) | `npx tsx demo/iou-charge.ts` | testnet |
| Charge with an **allowlisted IOU** (`RequireAuth`, issuer-controlled allowlist) | `npx tsx demo/iou-allowlist.ts` | testnet |
| Charge across two **different stablecoin issuers** (auto path-find + slippage) | `npx tsx demo/iou-cross-issuer.ts` | devnet |
| Charge with a **permissioned / allowlisted token** (MPT) | `npx tsx demo/mpt-charge.ts` | testnet |
| Stream **off-chain micropayments** (PayChannel: open, claim N times, close) | `npx tsx demo/channel-server.ts` + `npx tsx demo/channel-client.ts` (two terminals) | testnet |
| **Top up / recover** an exhausted PayChannel (open + `PaymentChannelFund` + close) | `npx tsx demo/channel-fund.ts` | testnet |
| Pay a **Claude LLM** per prompt in **native XRP** (SSE token stream back) | `npx tsx demo/llm-marketplace/charge/server.ts` + `npx tsx demo/llm-marketplace/charge/client.ts` (two terminals) | testnet |
| Pay a **Claude LLM** per prompt in an **IOU** (test `USD`, swap in any issuer) | `npx tsx demo/llm-marketplace/charge-iou/server.ts` + `npx tsx demo/llm-marketplace/charge-iou/client.ts` (two terminals) | testnet |
| Pay a **Claude LLM** per prompt in **MPT credits** (`CRED`, allowlisted) | `npx tsx demo/llm-marketplace/charge-mpt/server.ts` + `npx tsx demo/llm-marketplace/charge-mpt/client.ts` (two terminals) | testnet |
| Bill **N Claude prompts on one PayChannel** (2 on-chain txs total, eager deposit) | `npx tsx demo/llm-marketplace/channel/server.ts` + `npx tsx demo/llm-marketplace/channel/client.ts` (two terminals) | testnet |
| Bill **N Claude prompts on one PayChannel** with **just-in-time `PaymentChannelFund`** | `npx tsx demo/llm-marketplace/channel-fund/server.ts` + `npx tsx demo/llm-marketplace/channel-fund/client.ts` (two terminals) | testnet |
| Run a **paid HTTP API** (no API keys) billed in the API's own IOU (`WTH`) | `npx tsx demo/weather-api/server.ts` + `npx tsx demo/weather-api/client.ts` (two terminals) | testnet |
| Run a **paid HTTP API** billed in **real testnet RLUSD** (Ripple's stablecoin) | `npx tsx demo/weather-api-rlusd/server.ts` + `npx tsx demo/weather-api-rlusd/client.ts` (two terminals) | testnet |
| See a **full Claude agent with tool-use** paying an MPP-gated endpoint end-to-end | `pnpm agent-template` (one command) -- see [`examples/agent-template`](examples/agent-template) | testnet |
| Lock funds in **escrow** (time-lock, crypto-condition, cancellable refund) | `npx tsx demo/escrow-lifecycle.ts` | testnet |
| See **every failure mode** and how the SDK surfaces it (16 cases, fail-fix-validate) | `npx tsx demo/error-showcase.ts` | testnet |
| Simulate **pay-per-token LLM streaming** (offline, no network) | `npx tsx examples/stream-llm.ts` | none |

Each script generates fresh wallets via faucet, prints colored progress and explorer links, and exits cleanly. Nothing to clean up.

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
      escrow.ts              # createEscrow / finishEscrow / cancelEscrow + PREIMAGE-SHA-256 helper
      ledger-time.ts         # ripple-time <-> Date / ms / ISO conversions (escrow + channel timings)
      mpt.ts                 # ensureMPTHolding, lsfMPTRequireAuth detection
      paths.ts               # resolveIouPaymentExtras (ripple_path_find + SendMax + slippage)
      reserves.ts            # getReserveState, assertReserveCovers (owner-reserve preflight)
      trustline.ts           # ensureTrustline, checkRippling, freeze + RequireAuth detection
      validation.ts          # runPreflight, assertIssuerHealth (rippling, global freeze, RequireAuth)
      wallet.ts              # High-level Wallet API: fromSeed / fromFaucet, escrow + IOU + MPT + channel ops
    client/
      Charge.ts              # Client charge: preflight, IOU path resolve, sign, push/pull
      Methods.ts             # xrpl.charge() convenience wrapper
      index.ts
    server/
      Charge.ts              # Server charge: DID source bind, validate, submit, poll
      Methods.ts
      index.ts
    channel/
      Methods.ts             # Session schema (name: 'xrpl', intent: 'session'; 'channel' alias)
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
      auto-setup.devnet.test.ts
      channel.devnet.test.ts
      charge.devnet.test.ts
      charge-push.devnet.test.ts
      escrow.devnet.test.ts
      iou-cross-issuer.devnet.test.ts
      mpt-lifecycle.devnet.test.ts
    utils/test-helpers.ts
  demo/
    log.ts                   # Shared styled terminal output utility
    xrp-server.ts            # XRP charge server (two-terminal)
    xrp-client.ts            # XRP charge client (two-terminal)
    iou-charge.ts            # Same-issuer IOU charge all-in-one
    iou-allowlist.ts         # IOU + RequireAuth (issuer-controlled allowlist) all-in-one
    iou-cross-issuer.ts      # Cross-issuer IOU charge (devnet, all-in-one)
    mpt-charge.ts            # MPT charge all-in-one
    channel-server.ts        # PayChannel server (two-terminal)
    channel-client.ts        # PayChannel client (two-terminal)
    channel-server-open.ts   # PayChannel server demonstrating MPP-managed channel open
    channel-fund.ts          # PayChannel top-up lifecycle: open + claim + fund + recover + close (all-in-one)
    escrow-lifecycle.ts      # Escrow lifecycle: time-locked, crypto-condition, cancellable
    error-showcase.ts        # 16 error cases, fail-fix-validate
    llm-marketplace/         # Anthropic Claude over MPP -- five paid-LLM patterns
      charge/                #   one prompt = one on-chain Payment, native XRP
      charge-iou/            #   one prompt = one on-chain Payment, IOU (test USD; swap any issuer)
      charge-mpt/            #   one prompt = one on-chain Payment, MPT credits (allowlisted)
      channel/               #   N prompts amortised on a single PayChannel (eager deposit)
      channel-fund/          #   N prompts on a PayChannel + just-in-time PaymentChannelFund
      shared/anthropic.ts    #   shared Anthropic client, pricing constants, streaming helpers
    weather-api/             # Paid HTTP API (no API key), per-call billing in the API's own IOU (WTH)
    weather-api-rlusd/       # Paid HTTP API, per-call billing in real testnet RLUSD (production shape)
  examples/
    server.ts                # Minimal charge server (env var config)
    client.ts                # Minimal charge client (env var config)
    channel-server.ts        # Minimal channel server (env var config)
    channel-client.ts        # Minimal channel client (env var config)
    stream-llm.ts            # Pay-per-token streaming simulation (offline)
    channel-open-mpp.ts      # Channel open via MPP 402 flow (concept example)
    agent-template/          # Real-life starter: Claude agent (tool-use) paying a Claude-backed MPP service
      src/                   #   server.ts + agent.ts + client.ts + run-demo.ts + env.ts + intent.ts + log.ts
      package.json           #   standalone deps (folder can be lifted out of the monorepo)
      .env.example
  vitest.config.ts            # Unit suite + coverage threshold (80% on core modules)
  vitest.integration.config.ts # Devnet integration suite (single-fork, no coverage)
  .github/workflows/ci.yml    # Two jobs: unit (every push/PR) + integration (gated)
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

XRPL's native PayChannel primitive cannot offer the spec's atomic, either-party channel `close()` (settle + refund in one call), so the SDK adds server-side claim/auto-close recovery instead. See [MPP spec deviations](#mpp-spec-deviations) at the end of this README.

## License

Apache License 2.0. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).

## MPP spec deviations

`xrpl-mpp-sdk` follows the [Machine Payments Protocol (MPP)](https://mpp.dev) to the letter for the handshake, the `Credential` / `Receipt` envelopes, single-use proof semantics, and the cumulative-voucher session model. The deviations below all trace to a single root: XRPL exposes a **native [PayChannel](https://xrpl.org/payment-channels.html) primitive**, not the programmable escrow contract the spec's `session` intent was written against (Tempo's `TempoStreamChannel`).

### 1. Channel close: two transactions, not one

The MPP [`session` intent](https://mpp.dev/payment-methods/tempo/session) describes settlement as a single, symmetric operation:

> *"Either party can close the channel. The server calls `close()` on the escrow contract with the highest voucher, **settling the final balance on-chain and refunding any unused deposit** to the client."*

So in the reference model one `close()` call, callable by either side, atomically (a) pays the server what it earned and (b) refunds the client's unused deposit. XRPL has no escrow contract to do this — its native PayChannel splits "settle" and "refund" into two separate transactions, and restricts who may send each:

- `PaymentChannelClaim` **without** `tfClose` — pays the cumulative amount to the **destination** (server). The server may submit this. It does **not** refund the deposit and does **not** delete the channel.
- `PaymentChannelClaim` **with** `tfClose` — only the channel **source** (funder/client) may set this flag. It starts the `SettleDelay`, after which the channel is deleted and the unspent deposit is returned to the funder.

There is no single transaction, available to the server, that both pays the server and refunds the client. The spec's atomic, either-party `close()` simply does not exist on this primitive.

**What the SDK does about it.** Because off-chain vouchers are worthless until someone posts a `PaymentChannelClaim` on-chain, a client that just walks away would leave the server holding signed claims and no money. To preserve the spec's guarantee ("the server can always recover what it earned"), the SDK adds server-side recovery the contract specs get for free:

- **`closeFromStore()`** reads the highest cumulative voucher persisted for a channel and submits a `PaymentChannelClaim` (no `tfClose`) to pull those funds to the recipient. Idempotent -- no-ops if already finalized/redeemed.
- **Auto-close sweeper** (`autoClose`, on by default when a recipient `wallet` is provided) runs `closeFromStore` for any channel idle longer than `idleMs` (default 30s), then marks it finalized so later vouchers are rejected with `CHANNEL_CLOSED`.

```ts
channel({
  publicKey,
  store,
  wallet,          // recipient wallet -- required to sign the on-chain claim
  autoClose: { idleMs: 30_000 },
})
```

Two consequences, both following directly from the split above:

1. **The deposit refund is not automatic.** The server's claim leaves the channel object alive; the funder's unused deposit is only returned when the funder submits `tfClose` or a `CancelAfter` elapses. Set `cancelAfter` at channel creation so a channel cannot leak the funder's reserve indefinitely.
2. **The server needs the recipient wallet.** The spec's `close()` works from either side because the contract enforces correctness; here the server must actually sign an XRPL transaction.

Implementation: `close`, `closeFromStore`, and the sweeper live in [`sdk/src/channel/server/Channel.ts`](sdk/src/channel/server/Channel.ts); a real usage example is in [`demo/llm-marketplace/channel/server.ts`](demo/llm-marketplace/channel/server.ts).

### 2. Voucher verification is not strictly off-chain

The same "native primitive, no escrow contract" root produces one more deviation. The spec's `session` intent promises that the server verifies each voucher with *"fast signature checks -- no RPC or blockchain calls"*: with a smart-contract escrow, a valid signature is sufficient proof, because the contract guarantees the channel exists and is funded. XRPL has no such contract, so a cryptographically valid claim alone says nothing about whether the `channelId` is real or solvent. By default (`verifyChannelOnChain: true`) the SDK therefore pairs the local signature check with an on-chain `ledger_entry` lookup that confirms the channel exists, has not expired, and is funded above the claimed cumulative. The lookup is cached per channel (`channelMetadataTtlMs`, default 60s), so in practice it costs roughly one RPC on the first voucher and signature-only checks thereafter -- but it is still a departure from the spec's strictly off-chain critical path. Set `verifyChannelOnChain: false` to recover the spec's behaviour at the cost of accepting claims against unverified channels.
