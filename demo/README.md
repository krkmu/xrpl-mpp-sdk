# xrpl-mpp-sdk Demos

All demos use real XRPL testnet wallets funded via faucet at runtime.

## Prerequisites

- Node.js 20+
- pnpm

## How it works

1. Run a **setup script** -- it generates wallets, funds them, creates any required on-chain objects, and prints the commands you need for server + client.
2. Copy the **server command** into Terminal 1.
3. Copy the **client command** into Terminal 2.
4. Watch the full MPP 402 flow: challenge -> credential -> payment -> receipt.

## XRP Charge

```bash
npx tsx demo/setup-xrp.ts          # funds 2 wallets, prints commands
# Terminal 1: run the server command from setup output
# Terminal 2: run the client command from setup output
```

## IOU Charge

```bash
npx tsx demo/setup-iou.ts          # creates issuer, DefaultRipple, trustlines, issues tokens
# Terminal 1: run the server command from setup output
# Terminal 2: run the client command from setup output
```

## MPT Charge

```bash
npx tsx demo/setup-mpt.ts          # creates MPT issuance, authorizes holders, issues tokens
# Terminal 1: run the server command from setup output
# Terminal 2: run the client command from setup output
```

## PayChannel

```bash
npx tsx demo/setup-channel.ts      # funds wallets, opens PayChannel
# Terminal 1: run the server command from setup output
# Terminal 2: run the client command from setup output (makes 5 off-chain requests)
```

## Offline demos

```bash
npx tsx demo/error-showcase.ts     # all 11 error cases
npx tsx examples/stream-llm.ts     # pay-per-token streaming simulation
```

## Files

| File | Purpose |
|---|---|
| `setup-xrp.ts` | Fund 2 wallets for XRP charge |
| `setup-iou.ts` | Create issuer + trustlines + issue IOUs |
| `setup-mpt.ts` | Create MPT issuance + authorize + issue tokens |
| `setup-channel.ts` | Fund wallets + open PayChannel |
| `server.ts` | HTTP server with MPP 402 charge handler |
| `client.ts` | HTTP client with auto-402 handling |
| `server-channel.ts` | HTTP server with MPP 402 channel handler |
| `client-channel.ts` | HTTP client making N off-chain channel requests |
| `error-showcase.ts` | Demonstrates all SDK error types |
