# xrpl-mpp-sdk Demos

All demos use real XRPL testnet wallets funded via faucet at runtime.

## Prerequisites

- Node.js 20+
- pnpm

## Get Testnet Wallets

Visit https://faucet.altnet.rippletest.net/accounts to generate funded testnet wallets.
You need at least two wallets -- one for the server (recipient) and one for the client (payer).

## Demos

### XRP Charge (`charge-xrp.sh`)

Sends 1 XRP from client to server.

**Terminal 1 (Server):**
```bash
npx tsx demo/demo-server.ts --recipient rYOUR_SERVER_ADDRESS --currency XRP --amount 1000000
```

**Terminal 2 (Client):**
```bash
npx tsx demo/demo-client.ts --seed sEdYOUR_CLIENT_SEED --mode pull
```

### IOU Charge (`charge-iou.sh`)

Sends an IOU (auto-creates trustline if missing).

**Terminal 1 (Server):**
```bash
npx tsx demo/demo-server.ts --recipient rSERVER --currency '{"currency":"USD","issuer":"rISSUER"}' --amount 10
```

**Terminal 2 (Client):**
```bash
npx tsx demo/demo-client.ts --seed sEdCLIENT --mode pull
```

### MPT Charge (`charge-mpt.sh`)

Sends an MPT payment (auto-authorizes if needed).

**Terminal 1 (Server):**
```bash
npx tsx demo/demo-server.ts --recipient rSERVER --currency '{"mpt_issuance_id":"MPT_ID"}' --amount 100
```

**Terminal 2 (Client):**
```bash
npx tsx demo/demo-client.ts --seed sEdCLIENT --mode pull
```

### PayChannel (`channel.sh`)

Opens a channel, makes 5 off-chain payments, closes.

```bash
npx tsx demo/channel-demo.ts --sender-seed sEdSENDER --receiver-seed sEdRECEIVER
```

## Explorer Links

All demos print transaction links to the XRPL testnet explorer:
`https://testnet.xrpl.org/transactions/<TX_HASH>`
