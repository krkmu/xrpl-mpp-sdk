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
