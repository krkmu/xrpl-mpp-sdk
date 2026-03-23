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
| `iou-charge.ts` | All-in-one | Creates issuer, DefaultRipple, trustlines, issues USD, runs charge |
| `mpt-charge.ts` | All-in-one | Creates MPT issuance, authorizes holders, issues tokens, runs charge |
| `channel-server.ts` | Two-terminal | Server: verifies off-chain PayChannel claims (0.1 XRP each) |
| `channel-client.ts` | Two-terminal | Client: opens channel, 5 paid requests, closes channel |
| `error-showcase.ts` | All-in-one | 11 error cases with fail-fix-validate pattern |

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

Funds 3 wallets (issuer, server, client). Enables DefaultRipple on issuer. Creates trustlines for server and client. Issues 1000 USD to client. Starts MPP server on :3001. Client pays 10 USD. Prints explorer link for every tx (AccountSet, TrustSet x2, issuance, payment).

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

## Error Showcase

```bash
npx tsx demo/error-showcase.ts
```

Funds 10+ wallets and runs 11 cases sequentially:

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
