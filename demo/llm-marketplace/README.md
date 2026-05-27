# LLM Marketplace -- real Claude over MPP

A real-world workflow demo: an AI agent pays an LLM marketplace for
inference, on the XRP Ledger, via the Machine Payments Protocol. No mocks
on the payment side, no mocks on the LLM side -- the marketplace really
calls Anthropic's Claude API and bills you in drops on testnet.

## Demos

| Folder | Pattern | XRPL primitive | Status |
|---|---|---|---|
| `charge/` | One prompt = one on-chain Payment, billed in **native XRP** (drops) | `charge` (single tx per prompt) | ready |
| `charge-iou/` | One prompt = one on-chain Payment, billed in an **IOU** (test `USD` here; swap in any production issuer) | `charge` (single IOU tx per prompt) | ready |
| `charge-mpt/` | One prompt = one on-chain Payment, billed in **MPT credits** (`CRED`, allowlisted) | `charge` (single MPT tx per prompt) | ready |
| `channel/` | 3 prompts on a single PayChannel, eager 5 XRP deposit, off-chain vouchers per call | `channel` + PayChannel (2 txs total) | ready |
| `channel-fund/` | Same 3 prompts + tiny initial deposit + just-in-time `PaymentChannelFund` on `CHANNEL_EXHAUSTED` | `channel` + PayChannel + `PaymentChannelFund` | ready |
| `channel-stream/` | Many prompts streaming, taxi-meter vouchers per N tokens | `channel` + PayChannel | planned |

Start with `charge/` -- it's the smallest end-to-end loop, billed in
native XRP. `charge-iou/` is the same one-prompt = one-Payment flow
but priced in an XRPL issued currency (a test `USD` IOU here; swap in
any production issuer such as Ripple's RLUSD), so the caller can
reason about budget in the same units as the upstream provider's
invoice (no XRP/USD volatility). `charge-mpt/` swaps the IOU for a
**Multi-Purpose Token** -- an allowlisted prepaid-credit primitive
built specifically for SaaS-style metering (OpenAI-style credits with
the ledger moved on-chain). `channel/` folds N prompts into a single
PayChannel lifecycle (open + close), so the on-chain footprint is
constant regardless of how many prompts you fire, but you must
pre-commit the worst-case deposit. `channel-fund/` is the
capital-efficient variant: open with a tiny deposit, top up reactively
as needed. `channel-stream/` will go further and sign vouchers per N
output tokens within a single prompt.

> **Related demo** -- [`demo/weather-api/`](../weather-api/README.md) shows
> a paid HTTP API where the credit unit is the API's own trustlined IOU
> (`WTH`) instead of XRP. Same charge mode, no API keys, no LLM involved
> -- the closest analogue to OpenAI/Stripe prepaid credits with the ledger
> moved on-chain.

## Setup (once)

1. **Get an Anthropic API key** (free $5 credit for new accounts):
   - Go to [console.anthropic.com](https://console.anthropic.com)
   - Sign up + SMS phone verification
   - Click "Claim $5" in the dashboard banner
   - Settings -> API Keys -> Create Key -> copy `sk-ant-api03-...`

2. **Wire the key locally**:
   ```bash
   cp demo/llm-marketplace/.env.example demo/llm-marketplace/.env
   # then edit .env and paste your key
   ```
   `.env` is git-ignored.

## Run charge (one prompt, paid in native XRP)

Two terminals from the repo root:

```bash
# Terminal 1 -- marketplace server
npx tsx demo/llm-marketplace/charge/server.ts

# Terminal 2 -- AI agent client
npx tsx demo/llm-marketplace/charge/client.ts
```

### What happens

1. Server funds a recipient wallet via the testnet faucet, exposes
   `GET /info` (price discovery) and `POST /complete`
2. Client funds a payer wallet, calls `GET /info`, then `POST /complete`
   with `{ prompt, maxTokens }`
3. Server quotes worst-case cost in drops:
   `est_input_tokens × 10 + maxTokens × 50` and returns **HTTP 402**
   with that exact amount as the challenge
4. mppx auto-handles the 402: signs an XRPL `Payment` transaction
   for `cost` drops, submits it to testnet via the server (pull mode),
   server polls until the tx is `tesSUCCESS` validated
5. Server calls `anthropic.messages.stream(...)` with the real prompt and
   forwards each token delta as an SSE `event: token`
6. After Anthropic returns final usage, server emits `event: done` with
   `{ input_tokens, output_tokens, actual_cost, paid, overpayment }`
7. Client renders tokens live as they arrive (at Anthropic's real cadence)
   then prints a settlement box

### What's real, what's mocked

| Component | Status |
|---|---|
| XRPL Payment tx (open + validate on-chain) | **Real testnet** |
| MPP 402 challenge / credential / receipt flow | **Real** (uses `mppx` + this SDK) |
| Replay protection (`Store.memory()`) | **Real** |
| Anthropic API call | **Real** (uses your `ANTHROPIC_API_KEY`) |
| Token streaming via SSE | **Real** (cadence is Anthropic's actual rate) |
| Drop-to-token pricing | **Demo constants** (10/in, 50/out -- preserves the 1:5 input/output ratio of real Haiku) |

### Why pay-up-front (and not pay-after)?

`charge` mode requires the payment to land before the resource is served --
that is the HTTP 402 contract. We don't know exact Anthropic token counts
until generation completes, so we quote the worst case (maxTokens). The
overpayment is the cost of using this MPP-native pattern on a billing model
that's inherently post-hoc.

The `channel/` demo (below) keeps the same per-call worst-case quote but
amortises the on-chain cost across N prompts: 2 txs total instead of N.
The `channel-stream/` variant will go further and sign vouchers per N
output tokens within a single prompt, so the client pays close to the
real consumption.

## Run charge-iou (one prompt, paid in an IOU)

Same one-prompt-one-Payment flow as `charge/`, but the per-call charge
is denominated in an **XRPL issued currency (IOU)** instead of native
XRP. The wire protocol does not change -- only the currency on the 402
challenge and on the `Payment` tx the client signs.

The demo mints its own test IOU with the 3-char code `USD` (XRPL
native IOU codes are 3 ASCII chars; longer codes such as real `RLUSD`
require the 40-char hex-encoded format). On mainnet you swap the local
issuer for any production issuer (e.g. Ripple's RLUSD -- see
`RLUSD_MAINNET` in `sdk/src/constants.ts`); the charge code path does
not change.

Two terminals from the repo root:

```bash
# Terminal 1 -- marketplace server (PORT 3008)
npx tsx demo/llm-marketplace/charge-iou/server.ts

# Terminal 2 -- AI agent client
npx tsx demo/llm-marketplace/charge-iou/client.ts
```

### What changes vs `charge/`

| | `charge/` | `charge-iou/` |
|---|---|---|
| Currency on 402 | `XRP` (drops, integer) | IOU (decimal value, `{currency, issuer}`) |
| Server-side wallets | 1 (recipient) | 2 (issuer + recipient) |
| Per-call XRPL primitive | Native `Payment` | IOU `Payment` (same tx type, with `IssuedCurrencyAmount`) |
| One-time setup txs | 0 | 2 on the server (`enableTransfers` on issuer + recipient `TrustSet`), 1 on the client (`TrustSet`), 1 issuance for the demo allowance |
| Caller-facing unit | drops / XRP | issued currency (USD-pegged in this demo) |

### Pointing at a production issuer (e.g. RLUSD)

The wire layout (`{currency: "USD", issuer: <addr>}`) **is** the
production layout. To bill in Ripple's real RLUSD on mainnet instead
of the test `USD` IOU:

1. Edit `server.ts` -- remove the local `issuer` wallet, import
   `RLUSD_MAINNET` from `xrpl-mpp-sdk`, and replace
   `const currency = {...}` with `const currency = RLUSD_MAINNET`.
   Delete the `enableTransfers` call (only the real issuer can flip
   that flag).
2. Replace the `/faucet-usd` body with a paid top-up flow (card,
   DEX swap, fiat on-ramp). Ripple does not expose a programmatic
   faucet for RLUSD; on testnet, [tryrlusd.com](https://tryrlusd.com)
   distributes test RLUSD manually.
3. The recipient's `acceptToken(currency, ...)` keeps working: it only
   asserts that *some* account at `currency.issuer` exists.

For a tutorial-grade demo the local mock issuer keeps the entire flow
on a single `npx tsx` command with no manual funding step.

### What happens (delta from `charge/`)

1. **Server boot** -- fund two wallets via the testnet XRP faucet:
   - `issuer` (treasury): mints `USD`, runs `enableTransfers`
     (`asfDefaultRipple`) so payers can settle payments through it.
   - `recipient` (marketplace): opens a trustline to the issuer eagerly
     so the client-side path resolver finds it on the first 402.

2. **Client bootstrap** (one-time, before the paid call):
   - Fund a fresh payer wallet via the XRP faucet (XRP for the trustline
     reserve and tx fees -- not what we pay *with*).
   - `GET /info` discovers `{ issuer, recipient, currency, model, pricing }`.
   - `acceptToken` (TrustSet) toward the issuer so the payer can hold USD.
   - `POST /faucet-usd` -> the issuer mints 10 USD to the payer.
     Demo-only bootstrap; on mainnet replace with a paid top-up flow.

3. **Paid call** (same as `charge/`, just in an IOU):
   - Client `POST /complete` with `{ prompt, maxTokens }`.
   - Server quotes worst case in USD
     (`est_input_tokens × 0.0001 + maxTokens × 0.0005`) and returns
     HTTP 402 with that amount.
   - mppx intercepts the 402, signs an IOU `Payment` (pull mode), the
     server submits it to XRPL and polls until `tesSUCCESS`.
   - Server streams Anthropic tokens via SSE and emits `event: done`
     with real cost vs paid quote -- both in USD.

### Tunables (charge-iou)

`server.ts`:

| Constant | Default | What it is |
|---|---|---|
| `CURRENCY_CODE` | `USD` | 3-char IOU code (stand-in for any USD-pegged issuer) |
| `USD_PER_INPUT_TOKEN` | `0.0001` | demo marketplace fee, input side |
| `USD_PER_OUTPUT_TOKEN` | `0.0005` | demo marketplace fee, output side (1:5 mirrors Haiku) |
| `FAUCET_ALLOWANCE_USD` | `10` | Initial demo credit (≈ 285 calls at default pricing) |
| `PORT` | `3008` | HTTP port |

`client.ts`:

| Constant | Default | What it is |
|---|---|---|
| `PROMPT` | "Explain ..." | The prompt to send |
| `MAX_TOKENS` | `120` | Worst-case output tokens (drives the quote) |

## Run charge-mpt (one prompt, paid in MPT credits)

Same one-prompt-one-Payment flow as `charge/`, but the per-call charge
is denominated in a **Multi-Purpose Token (MPT)** called `CRED` --
allowlisted compute credits minted by the marketplace itself. This is
the closest XRPL primitive to the OpenAI / Twilio / Anthropic prepaid
credits model, with the ledger moved on-chain.

Two terminals from the repo root:

```bash
# Terminal 1 -- marketplace server (PORT 3009)
npx tsx demo/llm-marketplace/charge-mpt/server.ts

# Terminal 2 -- AI agent client
npx tsx demo/llm-marketplace/charge-mpt/client.ts
```

### Why MPT for an LLM marketplace?

MPTs are the XRPL primitive built specifically for SaaS-style prepaid
credits:

- **Identifier**: a 64-char hex `mpt_issuance_id` -- no 3-char currency
  code limit, no issuer/currency hex-encoding gymnastics.
- **Allowlist** (`requireAuthorization: true`, immutable): the issuer
  must counter-sign each holder before they can hold a balance. Maps
  naturally to KYC, subscriptions, invite codes.
- **Cap** (`maximumAmount`, immutable): the marketplace cannot mint
  credits beyond the declared supply -- a credible promise on-chain.
- **Reserve**: a single owner object on the holder (vs a trustline
  reserve per IOU issuer).
- **Transferability** (`allowTransfer: true`, immutable): mandatory for
  any pay-per-X flow.

### What changes vs `charge/` and `charge-iou/`

| | `charge/` | `charge-iou/` | `charge-mpt/` |
|---|---|---|---|
| Currency on 402 | `XRP` (drops, integer) | `USD` IOU (decimal value) | `CRED` MPT (integer, `mpt_issuance_id`) |
| Server-side wallets | 1 | 2 | 2 |
| Holder owner objects | 0 | 1 trustline | 1 MPToken |
| Allowlist | n/a | n/a | yes (immutable `requireAuthorization`) |
| One-time setup txs (server) | 0 | 2 (`enableTransfers` + recipient `TrustSet`) | 3 (`MPTokenIssuanceCreate` + recipient holder-side `MPTokenAuthorize` + issuer-side `MPTokenAuthorize`) |
| One-time setup txs (client) | 0 | 1 (`TrustSet`) + 1 (issuance) on `/faucet-usd` | 1 (holder `MPTokenAuthorize`) + 2 (issuer `MPTokenAuthorize` + issuance) on `/faucet-mpt` |

### What happens (delta from `charge-iou/`)

1. **Server boot** -- fund two wallets via the testnet XRP faucet, then:
   - `issuer.createToken({ requireAuthorization: true, allowTransfer: true, assetScale: 0, ... })` mints the `CRED` issuance and returns its `mpt_issuance_id`.
   - `recipient.acceptToken(mpt)` -- holder-side `MPTokenAuthorize`.
     Status: `pending_authorization` (the issuance is allowlisted).
   - `issuer.authorize(recipient, mpt)` -- issuer-side `MPTokenAuthorize`
     with the `Holder` field. Now the recipient can hold balance.

2. **Client bootstrap** (one-time, before the paid call):
   - Fund a fresh payer wallet via the XRP faucet.
   - `GET /info` discovers `{ issuer, recipient, token: { label, mpt_issuance_id }, model, pricing }`.
   - `acceptToken(mpt)` -- holder-side `MPTokenAuthorize` (status:
     `pending_authorization`).
   - `POST /faucet-mpt` -- the marketplace authorises us (issuer-side
     `MPTokenAuthorize`) **and** issues 10 000 `CRED` in one HTTP call,
     returning both tx hashes.

3. **Paid call** (same as `charge/`, just in MPT):
   - Client `POST /complete` with `{ prompt, maxTokens }`.
   - Server quotes worst case in credits
     (`est_input_tokens × 1 + maxTokens × 5`) and returns HTTP 402 with
     that amount.
   - mppx intercepts the 402, signs an MPT `Payment` (pull mode), the
     server submits to XRPL and polls until `tesSUCCESS`.
   - Server streams Anthropic tokens via SSE and emits `event: done`
     with real cost vs paid quote -- both in credits.

### Tunables (charge-mpt)

`server.ts`:

| Constant | Default | What it is |
|---|---|---|
| `TOKEN_LABEL` | `CRED` | Human-readable label (the wire identifier is the issuance id) |
| `CREDITS_PER_INPUT_TOKEN` | `1` | demo marketplace fee, input side |
| `CREDITS_PER_OUTPUT_TOKEN` | `5` | demo marketplace fee, output side (1:5 mirrors Haiku) |
| `FAUCET_ALLOWANCE_CREDITS` | `10_000` | Initial demo credit (≈ 28 calls at default pricing) |
| `MAX_SUPPLY_CREDITS` | `1_000_000` | Hard cap on the issuance (immutable) |
| `PORT` | `3009` | HTTP port |

The MPT is minted with `assetScale: 0` so every wire amount is a plain
integer (no decimals). Change to `assetScale: 2` (cents) or higher if
you want finer per-call granularity.

`client.ts`:

| Constant | Default | What it is |
|---|---|---|
| `PROMPT` | "Explain ..." | The prompt to send |
| `MAX_TOKENS` | `120` | Worst-case output tokens (drives the quote) |

## Run channel (3 prompts, 1 PayChannel)

Two terminals from the repo root:

```bash
# Terminal 1 -- marketplace server
npx tsx demo/llm-marketplace/channel/server.ts

# Terminal 2 -- AI agent client (3 prompts in a row)
npx tsx demo/llm-marketplace/channel/client.ts
```

### What happens

1. Server funds a recipient wallet on testnet, exposes
   `GET /info`, `POST /register`, `GET /open`, `POST /complete`,
   `GET /summary`
2. Client funds a payer wallet, calls `GET /info`, then
   `POST /register` to share its channel publicKey
3. Client pre-signs a `PaymentChannelCreate` (5 XRP) **without
   submitting**. `GET /open` triggers a 402; `mppx` ships the signed
   blob inside the credential; the **server** submits it on-chain
   and returns the `channelId` via the `Payment-Receipt` header
4. For each of the 3 prompts (`POST /complete`):
   - Server quotes worst-case cost in drops
     (`est_input_tokens × 10 + maxTokens × 50`) and returns **HTTP 402**
   - `mppx` reads the running cumulative from the challenge, signs a
     fresh `PaymentChannelClaim` for `prev_cumulative + worst_case_quote`,
     and retries the request **without** an on-chain tx
   - Server verifies the claim signature off-chain, calls
     `anthropic.messages.stream(...)`, and forwards each token delta
     as an SSE `event: token`
   - Server emits `event: done` with real `input_tokens`, `output_tokens`,
     real cost in drops, voucher overpayment for this call, and the
     latest signed cumulative
5. After the third prompt, the client signs the **final** cumulative
   and submits a single on-chain `PaymentChannelClaim tfClose` to
   redeem and close the channel
6. Settlement summary: per-call breakdown, voucher cumulative vs real
   total Anthropic cost, on-chain footprint (2 txs)

### Why this is interesting

| | `charge/` | `channel/` |
|---|---|---|
| Per-prompt UX | Identical (POST /complete, SSE response) | Identical |
| On-chain txs for N prompts | N | 2 (open + close) |
| Settlement latency per prompt | One ledger close (~4 s) | None (off-chain voucher) |
| Worst-case overpayment | Per call | Per call (carries forward in cumulative) |

Same 402 contract, same SSE token stream -- only the underlying XRPL
primitive changes. With the channel pattern, the *Nth* prompt and the
1st prompt have identical per-call cost (just signature math), no matter
how many you fire.

### Tunables (channel)

`channel/client.ts`:

| Constant | Default | What it is |
|---|---|---|
| `CHANNEL_AMOUNT_DROPS` | `5000000` (5 XRP) | Initial channel deposit |
| `SETTLE_DELAY_SECONDS` | `3600` | Delay before unilateral close |
| `PROMPTS` | 3 entries | Edit to send different prompts / budgets |

## Run channel-fund (just-in-time deposit growth)

Two terminals from the repo root:

```bash
# Terminal 1 -- marketplace server (PORT 3006)
npx tsx demo/llm-marketplace/channel-fund/server.ts

# Terminal 2 -- AI agent client (3 prompts, lazy-fund)
npx tsx demo/llm-marketplace/channel-fund/client.ts
```

### What changes vs `channel/`

The wire protocol is identical -- same `/info`, `/register`, `/open`,
`/complete`. The only differences are:

- The **client opens with `5000` drops** (not 5 000 000). That covers the
  worst-case quote of prompt 1 only.
- When the cumulative voucher would exceed the on-chain deposit, the
  server's `xrpl/channel` `verify()` throws an `AmountExceedsDepositError`
  (the typed `CHANNEL_EXHAUSTED`). **mppx catches that error internally**
  and re-issues the challenge as a fresh **HTTP 402** whose body is an
  RFC 9457 Problem Details document with
  `type: "https://paymentauth.org/problems/session/amount-exceeds-deposit"`.
  This is mppx's normal "verify failed -- here is a new challenge" pattern.
- The client peeks at the body of any 402 it receives. If the `type` field
  matches `amount-exceeds-deposit` (or the `detail` contains
  `CHANNEL_EXHAUSTED`), it submits a `PaymentChannelFund` on-chain to grow
  the deposit by the per-call worst-case quote, then retries the same
  `fetch('/complete', ...)` call. mppx re-runs the credential dance with a
  fresh challenge ID; the server's metadata cache auto-refreshes when the
  cumulative exceeds the cached balance, so the top-up is detected without
  manual cache busting.

### Cost shape (typical run, 3 prompts, Haiku 4.5)

| | `channel/` (eager) | `channel-fund/` (lazy) |
|---|---|---|
| Initial deposit | 5 XRP (5 000 000 drops) | 5 000 drops |
| Top-ups | 0 | 2 (one per exhausting prompt) |
| Peak locked at any moment | 5 000 000 drops | ~22 000 drops (~227× less) |
| On-chain txs | 2 (open + close) | 4 (open + 2 funds + close) |
| Off-chain claims | 3 | 3 |
| Per-call overpayment | identical | identical |

The trade-off is explicit: pay more in transaction fees to commit less
capital up-front. For an agent making thousands of prompts with unknown
total spend, the lazy variant is materially better. For a known short
workload, the eager variant is cheaper in fees and simpler.

### Tunables (channel-fund)

`channel-fund/client.ts`:

| Constant | Default | What it is |
|---|---|---|
| `INITIAL_DEPOSIT_DROPS` | `5000` | Tiny opening deposit (≈ prompt 1's worst case) |
| `SETTLE_DELAY_SECONDS` | `3600` | Delay before unilateral close |
| `MAX_FUND_RETRIES_PER_PROMPT` | `3` | Bound on the retry loop per prompt |
| `PROMPTS` | same 3 as `channel/` | Edit to send different prompts / budgets |

## Tunables

`shared/anthropic.ts`:

| Constant | Default | What it is |
|---|---|---|
| `MODEL` | `claude-haiku-4-5` | overridable via `ANTHROPIC_MODEL` env |
| `DROPS_PER_INPUT_TOKEN` | `10` | demo marketplace fee, input side |
| `DROPS_PER_OUTPUT_TOKEN` | `50` | demo marketplace fee, output side (1:5 ratio mirrors Haiku) |

Edit `PROMPT` and `MAX_TOKENS` near the top of `charge/client.ts` to try
other inputs. Anthropic Haiku 4.5 costs ~$0.001 per call here, so a few
dozen runs is well within the $5 trial.

## Production caveats

- The Anthropic key lives in `process.env` -- fine for a local demo,
  not how a real service should handle secrets. Use a KMS / Vault in
  production.
- `Store.memory()` is process-local. A real marketplace needs a shared
  store (Redis, DB) for replay protection across instances.
- The recipient wallet seed is freshly faucet-funded each run. In
  production, use a KMS-backed signer; the `examples/agent-template`
  shows the env-driven wallet pattern with a clear "do not do this in
  production" warning.
