# xrpl-mpp-sdk

XRPL payment method for the [Machine Payments Protocol (MPP)](https://mpp.dev). Extends [mppx](https://github.com/wevm/mppx) with XRP Ledger payment methods.

## Features

- **Charge (on-chain)**: Payment transactions for XRP, IOU (issued currencies), and MPT (multi-purpose tokens)
- **Channel (off-chain)**: PayChannel micropayments with cumulative claim signing
- **Streaming**: Pay-per-token via ChannelStream, session billing via ChannelSession
- **Dual-curve support**: ed25519 and secp256k1 wallets handled transparently
- **Pull and push modes**: Server-submit (pull, default) or client-submit (push)
- **Auto-trustline**: Opt-in automatic TrustSet for IOU payments
- **Auto-MPT authorize**: Opt-in automatic MPTokenAuthorize for MPT payments
- **Replay protection**: Store-backed dedup for both charge (tx hash) and channel (cumulative monotonicity)
- **MPP-compliant errors**: RFC 9457 Problem Details, interoperable with any mppx client/server

## Install

```bash
pnpm add xrpl-mpp-sdk xrpl mppx
```

## Quick Start

### Client (pay for resources)

```ts
import { Mppx } from 'mppx/client'
import { charge } from 'xrpl-mpp-sdk/client'

const mppx = Mppx.create({
  methods: [
    charge({
      seed: 'sEdV...',
      mode: 'pull',
      network: 'testnet',
    }),
  ],
})

// Automatically handles 402 challenges
const response = await mppx.fetch('https://api.example.com/resource')
```

### Server (charge for resources)

```ts
import { Mppx, Store } from 'mppx/server'
import { charge } from 'xrpl-mpp-sdk/server'

const mppx = Mppx.create({
  methods: [
    charge({
      recipient: 'rN7bRFgBrNZKoY2uu015bdjah11UbRZY',
      network: 'testnet',
      store: Store.memory(),
    }),
  ],
})
```

### Channel (off-chain micropayments)

```ts
// Client
import { channel } from 'xrpl-mpp-sdk/channel/client'

const method = channel({ seed: 'sEdV...', network: 'testnet' })

// Server
import { channel as serverChannel, Store } from 'xrpl-mpp-sdk/channel/server'

const method = serverChannel({
  publicKey: 'ED...',
  network: 'testnet',
  store: Store.memory(),
})
```

### Streaming (pay-per-token)

```ts
import { ChannelStream } from 'xrpl-mpp-sdk/channel'

const stream = new ChannelStream({
  channelId: '...',
  privateKey: wallet.privateKey,
  dropsPerUnit: '100',
  granularity: 10,
})

// As tokens arrive:
const claim = stream.tick(1)
if (claim) {
  // Send claim to server
}
```

## Export Map

| Path | Exports |
|---|---|
| `xrpl-mpp-sdk` | Methods, ChannelMethods, constants, toDrops, fromDrops, error helpers |
| `xrpl-mpp-sdk/client` | charge, xrpl, Mppx |
| `xrpl-mpp-sdk/server` | charge, xrpl, Mppx, Store, Expires |
| `xrpl-mpp-sdk/channel` | channel (schema), ChannelStream, ChannelSession |
| `xrpl-mpp-sdk/channel/client` | channel, openChannel, fundChannel, xrpl, Mppx |
| `xrpl-mpp-sdk/channel/server` | channel, close, xrpl, Mppx, Store, Expires |

## Payment Methods

### charge (on-chain)

Registered as `{ name: 'xrpl', intent: 'charge' }`.

| Mode | How it works |
|---|---|
| **pull** (default) | Client signs Payment tx, sends blob. Server submits to ledger. |
| **push** | Client submits Payment tx, sends hash. Server verifies on-chain. |

Supports:
- **XRP**: Native currency, amount in drops
- **IOU**: Issued currencies (USD, RLUSD, etc.) with optional auto-trustline
- **MPT**: Multi-purpose tokens with optional auto-authorize

### channel (off-chain)

Registered as `{ name: 'xrpl', intent: 'channel' }`.

PayChannels are XRP-only (denominated in drops). Off-chain cumulative claims
are signed using `signPaymentChannelClaim` from xrpl.js, which handles both
ed25519 and secp256k1 wallets transparently.

## Error Mapping

XRPL tecResult codes are mapped to MPP error types:

| tecResult | SDK Code | MPP Error Type |
|---|---|---|
| `tecPATH_DRY` | `PAYMENT_PATH_FAILED` | VerificationFailedError |
| `tecUNFUNDED_PAYMENT` | `INSUFFICIENT_BALANCE` | InsufficientBalanceError |
| `tecNO_DST` | `RECIPIENT_NOT_FOUND` | VerificationFailedError |
| `tecNO_AUTH` | `TRUSTLINE_NOT_AUTHORIZED` | VerificationFailedError |
| `tecNO_LINE` | `MISSING_TRUSTLINE` | VerificationFailedError |
| `temBAD_AMOUNT` | `INVALID_AMOUNT` | VerificationFailedError |

## Demos

See [demo/README.md](demo/README.md) for runnable two-terminal demos:

- `demo/charge-xrp.sh` -- XRP charge with explorer links
- `demo/charge-iou.sh` -- IOU charge with auto-trustline
- `demo/charge-mpt.sh` -- MPT charge with auto-authorize
- `demo/channel.sh` -- PayChannel lifecycle (create, 5 claims, close)
- `demo/error-showcase.ts` -- All error cases demonstrated

```bash
npx tsx demo/error-showcase.ts
```

## Development

```bash
pnpm install
pnpm check:types    # Type-check
pnpm lint           # Biome lint + format
pnpm test           # Run all tests
```

## License

MIT
