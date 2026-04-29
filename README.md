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

```ts
import { Mppx, Store } from 'mppx/server'
import { charge } from 'xrpl-mpp-sdk/server'

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

// Works with any HTTP framework
export async function handler(request: Request) {
  const result = await (mppx as any)['xrpl/charge']({
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

```ts
charge({
  recipient: string,                // XRPL classic address (r...)
  currency?: XrplCurrency,          // default: 'XRP'. Also: {currency, issuer} or {mpt_issuance_id}
  network?: 'mainnet' | 'testnet' | 'devnet',  // default: 'testnet'
  rpcUrl?: string,                  // custom WebSocket RPC URL
  store?: Store.Store,              // replay protection (recommended)
  autoTrustline?: boolean,          // auto-create TrustSet on recipient for IOUs (default: false)
  autoMPTAuthorize?: boolean,       // auto MPTokenAuthorize on recipient for MPTs (default: false)
  seed?: string,                    // recipient wallet seed -- required if autoTrustline or autoMPTAuthorize
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
  onProgress?: (event) => void,     // lifecycle callback (challenge, preflight, signing, signed, submitting, confirmed)
})
```

### Server options (channel)

```ts
channel({
  publicKey: string,                // channel funder's public key (ED... or 02.../03...)
  network?: 'mainnet' | 'testnet' | 'devnet',
  rpcUrl?: string,
  store?: Store.Store,              // required for cumulative tracking + replay protection
  verifyChannelOnChain?: boolean,   // verify channel state on-chain per claim (default: false)
  onDisputeDetected?: (state) => void, // called when unilateral close detected on-chain
})
```

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

### Replay protection

Provide an mppx `Store` to prevent credential reuse:

```ts
import { Store } from 'xrpl-mpp-sdk/server'

charge({
  recipient: 'r...',
  store: Store.memory(),     // or Store.upstash(), Store.cloudflare()
})
```

For charge: deduplicates challenge IDs and transaction hashes.
For channels: enforces strict cumulative monotonicity (new > previous).

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
| `tecUNFUNDED_PAYMENT` | `INSUFFICIENT_BALANCE` | InsufficientBalanceError |
| `tecPATH_PARTIAL` | `INSUFFICIENT_BALANCE` | InsufficientBalanceError |
| `tecNO_DST` | `RECIPIENT_NOT_FOUND` | VerificationFailedError |
| `tecNO_AUTH` | `TRUSTLINE_NOT_AUTHORIZED` | VerificationFailedError |
| `tecNO_LINE` | `MISSING_TRUSTLINE` | VerificationFailedError |
| `temBAD_AMOUNT` | `INVALID_AMOUNT` | VerificationFailedError |
| `terINSUF_FEE_B` | `INSUFFICIENT_FEE` | VerificationFailedError |
| `tecINSUFFICIENT_RESERVE` | `INSUFFICIENT_RESERVE` | VerificationFailedError |

Additional channel errors:
- `INVALID_SIGNATURE` -- InvalidSignatureError (claim signer mismatch)
- `REPLAY_DETECTED` -- VerificationFailedError (same cumulative resubmitted)
- `CHANNEL_NOT_FOUND` -- ChannelNotFoundError (410)
- `CHANNEL_EXPIRED` -- ChannelClosedError (410)

All errors extend mppx's `PaymentError` base class and serialize to RFC 9457 Problem Details format.

## Constants

| Constant | Value |
|---|---|
| `XRPL_RPC_URLS.testnet` | `wss://s.altnet.rippletest.net:51233` |
| `XRPL_RPC_URLS.mainnet` | `wss://xrplcluster.com` |
| `RLUSD_MAINNET` | `{ currency: 'RLUSD', issuer: 'rMxWzrBMyeKR9oJfYBrhAEGsxwsdLFSfim' }` |
| `RLUSD_TESTNET` | `{ currency: 'RLUSD', issuer: 'rQhWct2fTR9z7bBQaflfqMEr2u8avFFpKH' }` |
| `XRP_DECIMALS` | `6` |
| `BASE_RESERVE_DROPS` | `'1000000'` (1 XRP) |
| `OWNER_RESERVE_DROPS` | `'200000'` (0.2 XRP) |

## Demos

All demos run on XRPL testnet. Zero env vars -- every script generates wallets and funds them automatically. See [demo/README.md](demo/README.md) for details.

```bash
# XRP charge (two terminals)
npx tsx demo/xrp-server.ts          # Terminal 1
npx tsx demo/xrp-client.ts          # Terminal 2

# IOU charge (all-in-one: issuer + trustlines + issuance + charge)
npx tsx demo/iou-charge.ts

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

## Project structure

```
xrpl-mpp-sdk/
  sdk/src/
    index.ts                 # Root exports, constants, types, error helpers
    Methods.ts               # Method schema (name: 'xrpl', intent: 'charge')
    constants.ts             # RPC URLs, well-known currencies, reserves
    types.ts                 # XrplCurrency, config types
    errors.ts                # tecResult mapping, error constructors
    utils/
      currency.ts            # parseCurrency, buildAmount, isXrp/isIOU/isMPT
      trustline.ts           # ensureTrustline, checkRippling
      mpt.ts                 # ensureMPTHolding
      validation.ts          # runPreflight (balance + reserves + destination + rippling)
    client/
      Charge.ts              # Client charge: sign Payment tx, create credential
      Methods.ts             # xrpl.charge() convenience wrapper
      index.ts
    server/
      Charge.ts              # Server charge: verify + submit Payment tx
      Methods.ts             # xrpl.charge() convenience wrapper
      index.ts
    channel/
      Methods.ts             # Method schema (name: 'xrpl', intent: 'channel')
      stream.ts              # ChannelStream, ChannelSession
      index.ts
      client/
        Channel.ts           # Sign PayChannel claims, openChannel, fundChannel
        Methods.ts
        index.ts
      server/
        Channel.ts           # Verify claims, track cumulative, close()
        Methods.ts
        index.ts
  test/
    compliance/              # MPP protocol, intents, interop (42 tests)
    security/                # Replay, tamper, input validation, channel auth (38 tests)
    xrpl/                    # Charge, channel, trustline, MPT, dual-curve (61 tests)
    utils/test-helpers.ts
  demo/
    log.ts                   # Shared styled terminal output utility
    xrp-server.ts            # XRP charge server (two-terminal)
    xrp-client.ts            # XRP charge client (two-terminal)
    iou-charge.ts            # IOU charge all-in-one
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
```

## Development

```bash
pnpm install
pnpm check:types             # TypeScript strict mode
pnpm lint                    # Biome lint + format
pnpm test                    # Vitest (141 tests)
```

## Protocol

This SDK implements the [Machine Payments Protocol (MPP)](https://mpp.dev) HTTP 402 flow as specified in [draft-httpauth-payment-00](https://github.com/tempoxyz/mpp-specs). It extends the [mppx](https://github.com/wevm/mppx) framework with XRPL-specific payment methods.

## License

MIT
