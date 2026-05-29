# Demos

All demos run on XRPL testnet. Most need **zero environment variables** -- each
script generates and faucet-funds its own wallets. The only exceptions: the LLM
marketplace and agent demos need an Anthropic API key, and the RLUSD demo needs a
pre-funded testnet seed (Ripple has no RLUSD faucet). Output is styled with
timestamps, colored tags, and box-drawn headers.

## Prerequisites

- Node.js 20+
- pnpm
- Internet connection (testnet)

## Files

| File | Type | What it does |
|---|---|---|
| `log.ts` | utility | Styled terminal output (timestamps, colors, boxes) |
| `xrp-server.ts` / `xrp-client.ts` | two-terminal | 402-gated resource charged in native XRP |
| `iou-charge.ts` | all-in-one | Issuer enables transfers, both sides accept the token, charge runs |
| `iou-allowlist.ts` | all-in-one | `RequireAuth` flow: accept -> `pending_authorization` -> issuer authorizes -> charge |
| `iou-cross-issuer.ts` | all-in-one | 5 wallets, USD.A <-> USD.B bridge via market maker, cross-issuer path-finding |
| `mpt-charge.ts` | all-in-one | Creates MPT issuance, authorizes holders, issues tokens, runs charge |
| `channel-server.ts` / `channel-client.ts` | two-terminal | Off-chain PayChannel claims (0.1 XRP each), open + 5 vouchers + close |
| `channel-fund.ts` | all-in-one | Open tiny channel, exhaust it, top up via `PaymentChannelFund`, recover, close |
| `channel-server-open.ts` | all-in-one | Server-managed open: client signs `PaymentChannelCreate`, server submits it |
| `channel-auto-close-proof.ts` | all-in-one | Proof that the server sweeper auto-redeems a channel when the client disconnects |
| `llm-marketplace/*` | two-terminal | Real Anthropic Claude billed over MPP -- see its own README |
| `weather-api/*` | two-terminal | Premium HTTP API, no API key, billed in the API's own IOU (`WTH`) |
| `weather-api-rlusd/*` | two-terminal | Same flow billed in real testnet RLUSD; `setup-trustline.ts` bootstraps a wallet |
| `escrow-lifecycle.ts` | all-in-one | 3 escrow scenarios: time-locked, crypto-condition, cancellable |
| `error-showcase.ts` | all-in-one | 16 error cases with the fail-fix-validate pattern |

## XRP charge (two-terminal)

```bash
npx tsx demo/xrp-server.ts   # terminal 1, :3000
npx tsx demo/xrp-client.ts   # terminal 2
```

Client requests the resource, gets 402, signs a Payment, retries with the
credential, gets 200 + a receipt with an explorer link.

## IOU charge

```bash
npx tsx demo/iou-charge.ts
```

Funds issuer + server + client. Issuer `enableTransfers`, both sides
`acceptToken(USD)`, issuer credits the client, then the client pays 10 USD. No
direct `xrpl` import -- everything goes through the Wallet API.

## IOU allowlist (RequireAuth)

```bash
npx tsx demo/iou-allowlist.ts
```

Issuer enables `DefaultRipple` + `RequireAuth`. Holders `acceptToken` and land at
`pending_authorization`. An early credit attempt surfaces a typed
`TRUSTLINE_NOT_AUTHORIZED`; the issuer then `authorize`s both holders, credits the
client, and the charge runs.

## IOU cross-issuer

```bash
npx tsx demo/iou-cross-issuer.ts
```

5 wallets bridging `USD.A` and `USD.B` through a market maker, exercising
cross-issuer path-finding so a payer holding one issuer's USD can pay a recipient
who only trusts the other.

## MPT charge

```bash
npx tsx demo/mpt-charge.ts
```

Creates an `MPTokenIssuance` (`tfMPTCanTransfer`), authorizes server + client,
issues 10000 MPT to the client, then the client pays 100 MPT.

## PayChannel (two-terminal)

```bash
npx tsx demo/channel-server.ts   # terminal 1
npx tsx demo/channel-client.ts   # terminal 2
```

Client opens a 10 XRP channel, makes 5 paid requests settled by off-chain claims
(cumulative 100k -> 500k drops), then closes the channel. 2 on-chain txs, 5
off-chain claims.

## PayChannel fund / exhaustion / recovery

```bash
npx tsx demo/channel-fund.ts
```

Opens a tiny 200,000-drop channel, exhausts it, and shows the top-up lifecycle.

| Step | What it shows |
|---|---|
| Open | `PaymentChannelCreate` with reserve preflight |
| Claim | Off-chain voucher signing + cumulative tracking |
| Limit | `cumulative > deposit` -> typed `CHANNEL_EXHAUSTED` |
| Fund | `PaymentChannelFund` via `fundChannel` (same channelId) |
| Recover | Rejected claim retried successfully after top-up |
| Close | `PaymentChannelClaim tfClose` with the latest signature |

3 on-chain txs (open + fund + close), 6 off-chain claims. The server's metadata
cache auto-refreshes when a claim's cumulative exceeds the cached deposit, so the
top-up is detected without manual cache busting.

## PayChannel server-managed open

```bash
npx tsx demo/channel-server-open.ts
```

The `action: 'open'` flow: the client signs the `PaymentChannelCreate` but the
**server** submits it and extracts the `channelId` from the ledger metadata
(returned via the receipt). Contrast with `channel-client.ts`, where the client
submits the open tx itself. Then 3 off-chain voucher requests + an on-chain close.

## PayChannel auto-close proof

```bash
npx tsx demo/channel-auto-close-proof.ts
```

Proves the server-side sweeper redeems a channel when the client just disconnects
(never calls `close()`). Runs three controls: a negative control with
`autoClose: false` (balance stays 0), a positive control via the direct
`verify()` path, and a full end-to-end run through the real HTTP + mppx layer.

## LLM marketplace -- real Claude over MPP

A real AI agent paying an LLM marketplace for inference on the XRP Ledger. The
server actually calls Anthropic Claude and bills you in testnet funds. Requires an
Anthropic API key (free $5 trial credit at console.anthropic.com).

```bash
cp demo/llm-marketplace/.env.example demo/llm-marketplace/.env
# paste your sk-ant-api03-... key, then run any variant (two terminals):
npx tsx demo/llm-marketplace/charge/server.ts
npx tsx demo/llm-marketplace/charge/client.ts
```

| Variant | What it bills in |
|---|---|
| `charge/` | one Payment per prompt, native XRP |
| `charge-iou/` | one Payment per prompt, an IOU (test `USD`; swap in any production issuer) |
| `charge-mpt/` | one Payment per prompt, an MPT (`CRED`, allowlisted credits) |
| `charge-multi/` | two payment options (XRP + USD IOU) in a single 402; client picks one |
| `charge-swap/` | marketplace accepts only its own IOU (`CRD`); client holds USD and must swap on the testnet AMM first (`client-agent.ts` does it via a real Claude tool-use loop) |
| `channel/` | 3 prompts on one PayChannel, eager 5 XRP deposit, off-chain vouchers |
| `channel-fund/` | same 3 prompts, tiny deposit + just-in-time `PaymentChannelFund` |

Full walkthrough, ports, and tunables: `demo/llm-marketplace/README.md`.

## Weather API -- no API key, pay per call

```bash
npx tsx demo/weather-api/server.ts   # terminal 1, :3007
npx tsx demo/weather-api/client.ts   # terminal 2
```

A premium HTTP API that replaces `Authorization: Bearer sk-...` + monthly invoice
with `HTTP 402 -> on-chain micropayment -> 200`. The credit unit is the
marketplace's own trustlined IOU (`WTH`). The server holds an issuer + a recipient
wallet; the client funds a payer, opens a trustline, claims a demo allowance via
`/faucet-iou`, then pays 1 WTH per `/forecast` call. Full walkthrough:
`demo/weather-api/README.md`.

## Weather API -- real testnet RLUSD

```bash
cp demo/weather-api-rlusd/.env.example demo/weather-api-rlusd/.env
# set PAYER_SEED (a pre-funded seed from https://tryrlusd.com)
npx tsx demo/weather-api-rlusd/server.ts   # terminal 1, :3010
npx tsx demo/weather-api-rlusd/client.ts   # terminal 2
```

Same flow as `weather-api/` but billed in **real testnet RLUSD** (Ripple's
USD-pegged stablecoin) -- the production shape of the IOU charge model, with no
self-run treasury. The payer wallet comes from `.env` because Ripple has no RLUSD
faucet; `npx tsx demo/weather-api-rlusd/setup-trustline.ts` bootstraps a wallet's
trustline. Full walkthrough: `demo/weather-api-rlusd/README.md`.

## Escrow lifecycle

```bash
npx tsx demo/escrow-lifecycle.ts
```

Three escrow scenarios end-to-end, each using fail-fix-validate (trigger the typed
error first, then do the right thing). ~30 s on testnet (two 15 s time gates).

| # | Scenario | What it shows |
|---|---|---|
| 1 | Time-locked (5 XRP) | reserve preflight, `getEscrow` round-trip, `ESCROW_NOT_READY` on early finish, finish + entry deletion |
| 2 | Crypto-condition (4 XRP) | `generatePreimageCondition()`, `ESCROW_INVALID_FULFILLMENT` on missing/wrong fulfillment, finish with the correct preimage |
| 3 | Cancellable (3 XRP) | `ESCROW_NOT_READY` on early cancel, refund after `CancelAfter` |

## Error showcase

```bash
npx tsx demo/error-showcase.ts
```

16 error cases run sequentially with the fail-fix-validate pattern:

| # | Case | Error triggered | Fix applied |
|---|---|---|---|
| 1 | INSUFFICIENT_BALANCE | Unfunded wallet | Fund via faucet |
| 2 | RECIPIENT_NOT_FOUND | Non-existent destination | Fund destination |
| 3 | AMOUNT_MISMATCH | Client pays wrong amount | Correct amount |
| 4 | MISSING_TRUSTLINE | IOU without trustline | Create trustline + issue |
| 5 | PAYMENT_PATH_FAILED | Rippling disabled | Enable DefaultRipple |
| 6 | INSUFFICIENT_IOU_BALANCE | Zero token balance | Issue tokens |
| 7 | MPT_NOT_AUTHORIZED | MPT not authorized | Authorize + issue |
| 8 | INSUFFICIENT_MPT_BALANCE | Zero MPT balance | Issue tokens |
| 9 | WRONG_SIGNER | Claim with wrong key | Sign with correct key |
| 10 | REPLAY_DETECTED | Same cumulative twice | Increment cumulative |
| 11 | OVERPAY | Claim > channel deposit | Correct amount |
| 12 | SERVER_REDEEM | Client disappears | Server closes with stored claim |
| 13 | FINALIZED_CHANNEL | Credential on closed channel | Rejected with CHANNEL_CLOSED |
| 14 | INSUFFICIENT_RESERVE | Deposit too large for free balance | Top-up via faucet |
| 15 | PARTIAL_PAYMENT_REJECTED | `tfPartialPayment` flag | Sign without the flag |
| 16 | DESTINATION_TAG_MISMATCH | Missing required tag | Sign with the matching `DestinationTag` |

## Streaming (offline)

```bash
npx tsx examples/stream-llm.ts
```

Simulates pay-per-token LLM streaming with `ChannelStream`, signing a claim every
10 tokens. No testnet needed.

## Notes

- All wallets are ephemeral testnet wallets -- no real funds.
- Testnet explorer: https://testnet.xrpl.org/transactions/
- Testnet faucet: https://faucet.altnet.rippletest.net/accounts
- Testnet WebSocket: wss://s.altnet.rippletest.net:51233
