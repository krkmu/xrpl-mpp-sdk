# Demos

All demos run on XRPL testnet. Zero environment variables -- every script generates its own wallets and funds them via faucet automatically. Output is styled with timestamps, colored tags, and box-drawn headers.

## Prerequisites

- Node.js 20+
- pnpm
- Internet connection (testnet)

## Files

| File | Type | What it does |
|---|---|---|
| `log.ts` | Shared utility | Styled terminal output (timestamps, colors, boxes) |
| `xrp-server.ts` | Two-terminal | Server: 402-gated resource, charges 1 XRP |
| `xrp-client.ts` | Two-terminal | Client: pays 1 XRP, prints receipt + explorer link |
| `iou-charge.ts` | All-in-one | Issuer enables transfers, server + client accept the token, issuer credits client, charge runs |
| `iou-allowlist.ts` | All-in-one | Issuer flips RequireAuth, holders accept (`pending_authorization`), issuer authorizes, charge runs |
| `iou-cross-issuer.ts` | All-in-one | 5 wallets, USD.A <-> USD.B bridge via market maker, cross-issuer path-finding |
| `mpt-charge.ts` | All-in-one | Creates MPT issuance, authorizes holders, issues tokens, runs charge |
| `channel-server.ts` | Two-terminal | Server: verifies off-chain PayChannel claims (0.1 XRP each) |
| `channel-client.ts` | Two-terminal | Client: opens channel, 5 paid requests, closes channel |
| `channel-fund.ts` | All-in-one | Open tiny channel, exhaust it, top up via `PaymentChannelFund`, recover, close |
| `llm-marketplace/charge/{server,client}.ts` | Two-terminal | Real Anthropic Claude over MPP `charge`: 1 prompt = 1 on-chain Payment in **native XRP**, SSE token stream back |
| `llm-marketplace/charge-iou/{server,client}.ts` | Two-terminal | Same as `charge/`, but billed in an **IOU** (test `USD` here; swap in any production issuer such as Ripple's RLUSD) |
| `llm-marketplace/charge-mpt/{server,client}.ts` | Two-terminal | Same as `charge/`, but billed in an **MPT** (`CRED`, allowlisted compute credits) |
| `llm-marketplace/channel/{server,client}.ts` | Two-terminal | Real Anthropic Claude over MPP `channel`: 3 prompts amortised on a single PayChannel (open + N off-chain vouchers + close), eager 5 XRP deposit |
| `llm-marketplace/channel-fund/{server,client}.ts` | Two-terminal | Real Anthropic Claude over MPP `channel`: same 3 prompts, but the client opens with a tiny 5 000-drop deposit and tops up just-in-time via `PaymentChannelFund` on `CHANNEL_EXHAUSTED` |
| `weather-api/{server,client}.ts` | Two-terminal | Premium HTTP API with no API key: each `/forecast` call is gated by HTTP 402 and billed as one on-chain IOU Payment in the API's own token (`WTH`). Prepaid-credits model, on-chain |
| `weather-api-rlusd/{server,client}.ts` | Two-terminal | Same flow as `weather-api/`, but billed in **real testnet RLUSD** (Ripple's USD-pegged stablecoin). Payer wallet loaded from `.env` because we cannot faucet RLUSD -- production shape of the IOU charge model |
| `escrow-lifecycle.ts` | All-in-one | 3 escrow scenarios: time-locked, crypto-condition, cancellable |
| `error-showcase.ts` | All-in-one | 16 error cases with fail-fix-validate pattern |

## XRP Charge

```bash
# Terminal 1
npx tsx demo/xrp-server.ts

# Terminal 2
npx tsx demo/xrp-client.ts
```

Server funds a recipient wallet, starts HTTP on :3000. Client funds a payer wallet, requests the resource, gets 402, signs Payment tx, retries with credential, gets 200 + receipt with explorer link.

## IOU Charge

```bash
npx tsx demo/iou-charge.ts
```

Funds 3 wallets (issuer, server, client). Issuer enables transfers (`enableTransfers`). Server and client accept USD (`acceptToken`). Issuer credits client with 1000 USD (`issue`). Starts MPP server on :3001. Client pays 10 USD. Zero `xrpl` import in the demo -- everything goes through the Wallet API.

## IOU allowlist (RequireAuth)

```bash
npx tsx demo/iou-allowlist.ts
```

Funds 3 wallets and walks the issuer-controlled allowlist flow end-to-end:

1. Issuer enables `DefaultRipple` and `RequireAuth` (must precede any
   trustline).
2. Server and client `acceptToken(USD)` -- both lines land at
   `pending_authorization`. The line exists but cannot hold a balance.
3. Issuer attempts to credit the client BEFORE authorizing -- ledger
   answers `tecNO_AUTH`, surfaced by the SDK as a typed
   `TRUSTLINE_NOT_AUTHORIZED`.
4. Issuer `authorize`s both holders (TrustSet `tfSetfAuth`). The line
   flips from `authorized: false` to `authorized: true`.
5. Issuer credits client + the regular MPP charge flow runs (10 USD).

Zero `xrpl` import. Mirrors `mpt-charge.ts` for the IOU path.

## MPT Charge

```bash
npx tsx demo/mpt-charge.ts
```

Funds 3 wallets. Creates MPTokenIssuance (tfMPTCanTransfer). Authorizes server and client. Issues 10000 MPT to client. Starts MPP server on :3002. Client pays 100 MPT. Prints explorer link for every tx.

## PayChannel

```bash
# Terminal 1
npx tsx demo/channel-server.ts

# Terminal 2
npx tsx demo/channel-client.ts
```

Server funds a wallet, exposes /info, /setup, /resource, /summary. Client funds a wallet, opens a 10 XRP channel (PaymentChannelCreate), configures the server, makes 5 paid requests (cumulative 100k, 200k, 300k, 400k, 500k drops), closes the channel (PaymentChannelClaim tfClose). 2 on-chain txs, 5 off-chain claims. Prints explorer links for create + close.

## PayChannel fund / exhaustion / recovery

```bash
npx tsx demo/channel-fund.ts
```

All-in-one demo of the top-up lifecycle. Funds 2 wallets, opens a tiny
200,000-drop channel, makes 4 successful paid requests (cumulatives 50k
to 200k -- the last matches the deposit exactly and is still accepted),
then deliberately tries a 5th claim of 250k drops. The server detects
that the cumulative now exceeds the on-chain deposit and surfaces a
typed `CHANNEL_EXHAUSTED`. The funder calls `wallet.fundChannel(...)`
to add 500,000 drops via `PaymentChannelFund`; the server's metadata
cache auto-refreshes when the next claim's cumulative exceeds the cached
deposit, so the top-up is detected without any manual cache busting.
Two more paid requests succeed, then the channel is closed on-chain.

| # | What it shows |
|---|---|
| Open  | `PaymentChannelCreate` with reserve preflight |
| Claim | Off-chain voucher signing + cumulative tracking |
| Limit | `cumulative > deposit` -> typed `CHANNEL_EXHAUSTED` |
| Fund  | `PaymentChannelFund` via `fundChannel` (no new channelId) |
| Recover | Rejected claim retried successfully after top-up |
| Close | `PaymentChannelClaim tfClose` with the latest signature |

3 on-chain txs (open + fund + close), 6 off-chain claims (5 distinct
vouchers + 1 retry).

## LLM Marketplace -- real Claude over MPP (use case)

```bash
# One-time setup
cp demo/llm-marketplace/.env.example demo/llm-marketplace/.env
# edit .env and paste your Anthropic API key (free $5 credit at console.anthropic.com)

# Terminal 1 -- billed in native XRP
npx tsx demo/llm-marketplace/charge/server.ts

# Terminal 2
npx tsx demo/llm-marketplace/charge/client.ts
```

A real-world workflow: an AI agent pays an LLM marketplace for inference,
on the XRP Ledger, via the MPP HTTP 402 flow. The server actually calls
Anthropic Claude (Haiku 4.5 by default) and bills you in drops on testnet.

| # | What it shows |
|---|---|
| Quote    | Server estimates input tokens locally, quotes `est × 10 + maxTokens × 50` drops |
| 402      | Standard MPP challenge for the quoted amount |
| Pay      | mppx signs an XRPL `Payment` tx, server submits to testnet, polls until validated |
| Stream   | Server calls `anthropic.messages.stream(...)`, forwards each delta as SSE `event: token` |
| Settle   | Server emits `event: done` with real `input_tokens` + `output_tokens` from Anthropic, real cost in drops vs the worst-case quote |

One on-chain Payment per prompt. Everything except the drop pricing
ratio is real. Two sibling variants bill the same flow in different
asset types: `charge-iou/` (XRPL issued currency, e.g. a USD-pegged
stablecoin) and `charge-mpt/` (Multi-Purpose Token credits, allowlisted).
See `demo/llm-marketplace/README.md` for the full walkthrough, setup,
and what's planned for the streaming PayChannel variant
(`channel-stream/`).

## LLM Marketplace -- channel mode (3 prompts, 1 PayChannel)

```bash
# (uses the same .env as charge/)

# Terminal 1
npx tsx demo/llm-marketplace/channel/server.ts

# Terminal 2 -- runs 3 prompts back-to-back
npx tsx demo/llm-marketplace/channel/client.ts
```

Same marketplace, same SSE token stream, but billed via a single PayChannel
instead of one Payment per prompt. The client pre-signs a
`PaymentChannelCreate` blob; the server submits it on-chain (server-managed
open) and returns the `channelId` via the `Payment-Receipt` header. Each
`POST /complete` then triggers a 402 (`xrpl/channel`, `action: voucher`):
mppx auto-signs a cumulative `PaymentChannelClaim` for
`prev_cumulative + worst_case_quote`, the server verifies it off-chain --
**no transaction** -- and streams Anthropic tokens back. After the third
prompt, the client closes the channel with the latest cumulative.

| # | What it shows |
|---|---|
| Open    | Client signs `PaymentChannelCreate`, server submits via MPP `action: 'open'`, channelId returned in the receipt header |
| Voucher | 3 sequential prompts, each settled by an off-chain claim signature (no on-chain tx) |
| Stream  | Same SSE `event: token` cadence as charge mode, real Anthropic generation |
| Settle  | Server emits per-call `event: done` with real cost, voucher overpayment, and running cumulative |
| Close   | One on-chain `PaymentChannelClaim tfClose` redeems and finalises the channel |

Net result: **2 on-chain txs for 3 prompts** (vs 3 in charge mode), constant
regardless of N. The settlement summary on the client prints per-call
breakdown plus voucher cumulative vs real Anthropic cost.

## LLM Marketplace -- channel + just-in-time fund (capital-efficient)

```bash
# (uses the same .env as charge/)

# Terminal 1
npx tsx demo/llm-marketplace/channel-fund/server.ts

# Terminal 2 -- 3 prompts, lazy-fund the channel as needed
npx tsx demo/llm-marketplace/channel-fund/client.ts
```

Same wire protocol as `channel/`, but the client opens the channel with
a deliberately tiny **5 000-drop deposit** (just enough for prompt 1's
worst case). When prompts 2 and 3 try to commit a cumulative larger than
the on-chain deposit, the server's `xrpl/channel` verify throws
`AmountExceedsDepositError`; mppx catches that and re-issues the challenge
as a fresh **HTTP 402** whose body is a Problem Details document with
`type: ".../amount-exceeds-deposit"`. The client peeks at the body, sees
that type, submits a `PaymentChannelFund` (one on-chain tx) and retries
`fetch('/complete', ...)`. mppx re-runs the credential dance, the server's
metadata cache auto-refreshes when needed, and the same voucher signature
is accepted on the second attempt.

| # | What it shows |
|---|---|
| Lazy open  | `PaymentChannelCreate` with a deposit sized for the first prompt only |
| Voucher    | Same off-chain claim flow as `channel/` |
| Exhaust    | Verify throws `AmountExceedsDepositError`; mppx surfaces it as a 402 with Problem Details `type: ".../amount-exceeds-deposit"` |
| Top-up     | `PaymentChannelFund` adds the per-call worst-case quote to the channel's on-chain `Amount` |
| Retry      | Same `/complete` request succeeds on second try -- same channelId, same signing key |
| Close      | Same as `channel/`: client closes with the latest cumulative |

Trade-off vs `channel/`: more on-chain transactions (open + N funds +
close) in exchange for a much smaller peak locked deposit
(~22 000 drops vs 5 000 000 drops for the same 3 prompts). Useful when
the agent doesn't know its total spend up front, or when capital
efficiency matters more than transaction-fee minimisation.

## Weather API -- no API key, pay per call in the API's own token

```bash
# Terminal 1 -- the weather API (PORT 3007)
npx tsx demo/weather-api/server.ts

# Terminal 2 -- a consumer, pays per call in WTH
npx tsx demo/weather-api/client.ts
```

A premium HTTP API that replaces `Authorization: Bearer sk-...` + monthly
invoice with `HTTP 402 -> on-chain micropayment -> 200`. The credit unit
is the marketplace's own trustlined IOU (`WTH`), not XRP -- the same
prepaid-credits model OpenAI / Stripe / Twilio already use, but with the
ledger moved on-chain.

The server holds two XRPL accounts: an **issuer** (treasury, mints `WTH`)
and a **recipient** (revenue collector, holds a trustline to the issuer).
The client funds a payer wallet from the faucet, opens its own trustline
to the issuer, claims a demo allowance via `/faucet-iou`, then calls
`POST /forecast` once per city in its `CITIES` array. mppx silently
handles every 402: signs an IOU `Payment` of 1 WTH from payer to
recipient, submits it via the server, retries the request once the tx
is `tesSUCCESS`.

| # | What it shows |
|---|---|
| Setup     | Issuer enables `asfDefaultRipple`, recipient opens trustline to issuer (required by the client-side path resolver before the first 402) |
| Bootstrap | Client TrustSet + `/faucet-iou` (demo mints 10 WTH; production would be a paid top-up) |
| Pay       | Per call: mppx auto-signs an IOU Payment of 1 WTH, server polls until validated, returns the forecast JSON |
| Settle    | Per-call breakdown: tx hashes, WTH spent vs initial allowance |

No environment variables, no external services -- everything runs on
testnet wallets faucet-funded at boot. Full walkthrough:
`demo/weather-api/README.md`.

## Weather API -- pay per call in real testnet RLUSD

```bash
# One-time setup -- bring a testnet seed that already holds RLUSD
cp demo/weather-api-rlusd/.env.example demo/weather-api-rlusd/.env
# edit .env and set PAYER_SEED (get a pre-funded seed from https://tryrlusd.com)

# Terminal 1 -- the weather API (PORT 3010)
npx tsx demo/weather-api-rlusd/server.ts

# Terminal 2 -- a consumer, pays per call in RLUSD
npx tsx demo/weather-api-rlusd/client.ts
```

Same wire flow as `weather-api/` but billed in **real testnet RLUSD**
(Ripple's USD-pegged stablecoin) instead of a self-minted `WTH` IOU.
This is the production shape of the IOU charge model: the marketplace
accepts a widely-held stablecoin (`RLUSD_TESTNET` / `RLUSD_MAINNET`
from `xrpl-mpp-sdk`) and never has to operate its own treasury -- no
issuer wallet, no `enableTransfers`, no `/faucet-iou` endpoint to
mint demo credits.

The payer wallet is loaded from `.env` (`PAYER_SEED`) because Ripple
does not expose a programmatic faucet for RLUSD; the address must
already hold some testnet RLUSD (free from https://tryrlusd.com) plus
a small XRP balance for the trustline reserve and per-tx fees.

| # | What it shows |
|---|---|
| Setup     | Recipient opens (or confirms) a trustline to Ripple's RLUSD testnet issuer; the payer's trustline + balance are pre-funded out of band |
| Bootstrap | Client loads `PAYER_SEED` from `.env`, sanity-checks RLUSD balance, aborts early with a pointer to https://tryrlusd.com if zero |
| Pay       | Per call: mppx auto-signs an RLUSD Payment of 0.1 RLUSD, server polls until validated, returns the forecast JSON |
| Settle    | Per-call breakdown: tx hashes, on-chain RLUSD balance before/after the run |

Full walkthrough including mainnet migration path:
`demo/weather-api-rlusd/README.md`.

## Escrow Lifecycle

```bash
npx tsx demo/escrow-lifecycle.ts
```

Funds 6 ephemeral wallets (creator + recipient per scenario) and walks the
three escrow scenarios end-to-end. Each scenario uses fail-fix-validate:
attempt the wrong thing first to surface the typed SDK error, then perform
the correct action and confirm on-chain settlement.

| # | Scenario | What it shows |
|---|---|---|
| 1 | Time-locked (5 XRP) | Reserve preflight on `EscrowCreate`, `getEscrow` round-trip with `DestinationTag`, `ESCROW_NOT_READY` raised on early finish, finish + ledger-entry deletion |
| 2 | Crypto-condition (4 XRP) | `generatePreimageCondition()` helper, `ESCROW_INVALID_FULFILLMENT` raised on missing fulfillment AND on wrong fulfillment, finish with the correct preimage |
| 3 | Cancellable (3 XRP) | `ESCROW_NOT_READY` raised on early cancel, cancel after `CancelAfter` refunds creator |

Total runtime: ~30 s on testnet (15 s wait in scenario 1, 15 s wait in
scenario 3, scenario 2 has no time gate).

## Error Showcase

```bash
npx tsx demo/error-showcase.ts
```

Funds 10+ wallets and runs 16 cases sequentially:

| # | Case | Error triggered | Fix applied |
|---|---|---|---|
| 1 | INSUFFICIENT_BALANCE | Unfunded wallet | Fund via faucet |
| 2 | RECIPIENT_NOT_FOUND | Non-existent destination | Fund destination |
| 3 | AMOUNT_MISMATCH | Client pays wrong amount | Correct amount |
| 4 | MISSING_TRUSTLINE | IOU without trustline | Create trustline + issue tokens |
| 5 | PAYMENT_PATH_FAILED | Rippling disabled | Enable DefaultRipple |
| 6 | INSUFFICIENT_IOU_BALANCE | Zero token balance | Issue tokens |
| 7 | MPT_NOT_AUTHORIZED | MPT not authorized | Authorize + issue |
| 8 | INSUFFICIENT_MPT_BALANCE | Zero MPT balance | Issue tokens |
| 9 | WRONG_SIGNER | Claim with wrong key | Sign with correct key |
| 10 | REPLAY_DETECTED | Same cumulative twice | Increment cumulative |
| 11 | OVERPAY | Claim > channel deposit | Correct amount |
| 12 | SERVER_REDEEM | Client disappears, server redeems stored claim on-chain | Server calls close() with stored signature |
| 13 | FINALIZED_CHANNEL | Credential on closed channel | Rejected with CHANNEL_CLOSED |
| 14 | INSUFFICIENT_RESERVE | Channel deposit too large for free balance | Top-up via faucet |
| 15 | PARTIAL_PAYMENT_REJECTED | Hand-crafted Payment with `tfPartialPayment` flag | Sign without the flag (standard SDK path) |
| 16 | DESTINATION_TAG_MISMATCH | Server requires a tag, client signs without | Sign with the matching `DestinationTag` |

## Streaming (offline)

```bash
npx tsx examples/stream-llm.ts
```

Simulates pay-per-token LLM streaming using ChannelStream. Signs claims every 10 tokens. No testnet needed.

## Notes

- All wallets are ephemeral testnet wallets -- no real funds
- Testnet explorer: https://testnet.xrpl.org/transactions/
- Testnet faucet: https://faucet.altnet.rippletest.net/accounts
- Testnet WebSocket: wss://s.altnet.rippletest.net:51233
