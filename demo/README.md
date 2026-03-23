# xrpl-mpp-sdk Demos

## Overview

| Demo | Script(s) | What it does |
|---|---|---|
| XRP Charge | `xrp-server.ts` + `xrp-client.ts` | Two-terminal 402 charge flow paying 1 XRP |
| IOU Charge | `iou-charge.ts` | All-in-one: creates issuer, trustlines, issues tokens, runs charge flow |
| MPT Charge | `mpt-charge.ts` | All-in-one: creates MPT issuance, authorizes holders, runs charge flow |
| PayChannel | `channel-server.ts` + `channel-client.ts` | Two-terminal: opens channel, 5 off-chain claims, closes channel |
| Error Showcase | `error-showcase.ts` | 11 error cases with fail-fix-validate pattern |

## Prerequisites

- Node.js 20+
- pnpm
- Internet connection (all demos run on XRPL testnet)

No environment variables needed. Every script generates its own wallets and funds them via the testnet faucet automatically.

## Demo 1: XRP Charge

Two terminals -- server accepts 1 XRP payments, client pays and gets content.

```bash
# Terminal 1
npx tsx demo/xrp-server.ts

# Terminal 2
npx tsx demo/xrp-client.ts
```

Expected output:

```
# Server
[server] Recipient: rXXX...
[server] Ready on http://localhost:3000 -- pay 1 XRP to access /resource
[server] 402 /resource
[server] 200 /resource

# Client
[client] Wallet: rYYY...
[client] Requesting http://localhost:3000/resource...
[client] Response status: 200
[client] Body: { "message": "Access granted -- paid 1 XRP", ... }
[client] Explorer: https://testnet.xrpl.org/transactions/ABC123...
```

## Demo 2: IOU Charge

Single script -- creates issuer + trustlines + issues USD tokens, then runs charge flow.

```bash
npx tsx demo/iou-charge.ts
```

Expected output: issuer setup (AccountSet, TrustSet x2, Payment), then 402 -> 200 with IOU payment. Explorer links for every on-chain tx.

## Demo 3: MPT Charge

Single script -- creates MPT issuance, authorizes holders, issues tokens, runs charge flow.

```bash
npx tsx demo/mpt-charge.ts
```

Expected output: MPTokenIssuanceCreate, MPTokenAuthorize x2, Payment (issuance), then 402 -> 200 with MPT payment. Explorer links for every on-chain tx.

## Demo 4: PayChannel

Two terminals -- client opens a channel, makes 5 off-chain micropayments (0.1 XRP each), closes.

```bash
# Terminal 1
npx tsx demo/channel-server.ts

# Terminal 2
npx tsx demo/channel-client.ts
```

Expected output:

```
# Client
[client] Channel: ABCDEF...
[client] Create tx: https://testnet.xrpl.org/transactions/...
  [1/5] 200 OK -- cumulative: 100000 drops
  [2/5] 200 OK -- cumulative: 200000 drops
  [3/5] 200 OK -- cumulative: 300000 drops
  [4/5] 200 OK -- cumulative: 400000 drops
  [5/5] 200 OK -- cumulative: 500000 drops
[client] Close tx: https://testnet.xrpl.org/transactions/...

=== Summary ===
  Off-chain claims: 5
  Total settled: 500000 drops (0.5 XRP)
  On-chain txs: 2 (create + close)
```

## Demo 5: Error Showcase

Single script -- demonstrates 11 error cases with fail-fix-validate pattern.

```bash
npx tsx demo/error-showcase.ts
```

Cases covered:
1. INSUFFICIENT_BALANCE -- unfunded wallet
2. RECIPIENT_NOT_FOUND -- non-existent destination
3. AMOUNT_MISMATCH -- wrong payment amount
4. MISSING_TRUSTLINE -- IOU without trustline
5. PAYMENT_PATH_FAILED -- rippling disabled
6. INSUFFICIENT_IOU_BALANCE -- zero token balance
7. MPT_NOT_AUTHORIZED -- MPT not authorized
8. INSUFFICIENT_MPT_BALANCE -- zero MPT balance
9. WRONG_SIGNER -- channel claim with wrong key
10. REPLAY_DETECTED -- same cumulative amount twice
11. OVERPAY -- claim more than channel deposit

Each case: attempt (fail) -> fix -> retry (succeed) -> print explorer link.

## Notes

- All wallets are ephemeral testnet wallets -- no real funds involved
- Testnet explorer: https://testnet.xrpl.org/transactions/
- Testnet faucet: https://faucet.altnet.rippletest.net/accounts
- Testnet WebSocket: wss://s.altnet.rippletest.net:51233
