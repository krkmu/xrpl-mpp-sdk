# XRPL MPP — AI Agent Template

A minimal end-to-end template that mirrors how an AI agent integrator
would consume `xrpl-mpp-sdk`.

```
+-----------------+   POST /agent/run    +-----------------+
|                 |  { prompt, model,    |                 |
|                 |    maxTokens }       |                 |
|   AI client     | -------------------> |   Agent server  |
|   (TS, holds    |                      |   (Express,     |
|    payer seed)  | <- 402 challenge --- |    holds        |
|                 |                      |    recipient    |
|                 |   sign Payment tx    |    seed)        |
|                 | -------------------> |                 |
|                 |   200 + result       |                 |
|                 |   + Payment-Receipt  |                 |
|                 | <------------------- |                 |
+-----------------+                      +-----------------+
                                                 |
                                                 |  validate intent
                                                 |  verify payment on XRPL
                                                 |  run agent (mock LLM)
                                                 v
                                         +---------------+
                                         |  XRPL testnet |
                                         +---------------+
```

## What's inside

- **Express server** holding a recipient wallet, exposing
  - `GET  /info`        — public price/recipient discovery
  - `POST /agent/run`   — payment-gated agent endpoint
- **TypeScript client** that builds an intent, calls the server,
  pays the 402 challenge, and prints the receipt
- **Env-based wallet management** (with a strict "do not do this in
  production" note)
- **One end-to-end flow**: intent → validate → 402 challenge →
  on-chain XRPL Payment → agent execution → receipt

## Run it (one command)

From the SDK repo root, after `pnpm install`:

```bash
pnpm agent-template
```

That single command:

1. funds two ephemeral testnet wallets via the faucet,
2. boots the Express server on `http://localhost:3000`,
3. runs the TS client against it,
4. prints the agent result, the receipt, and an explorer link,
5. shuts the server down and exits.

If you set `RECIPIENT_SEED` and/or `PAYER_SEED` in
`examples/agent-template/.env`, those wallets are used instead — no
faucet calls.

## Run server and client separately

```bash
# terminal 1 — server (boots on :3000)
pnpm tsx examples/agent-template/src/server.ts

# terminal 2 — client (sends an intent, prints receipt)
pnpm tsx examples/agent-template/src/client.ts
```

## Use as a starter (copy out of the repo)

```bash
cp -r examples/agent-template ~/my-xrpl-agent
cd ~/my-xrpl-agent
pnpm install
cp .env.example .env   # then fill it in
pnpm dev:server        # one terminal
pnpm dev:client        # another terminal
```

## Wallet management

`src/env.ts` exposes `loadWallets()`. It reads:

| Variable          | Purpose                                                |
| ----------------- | ------------------------------------------------------ |
| `RECIPIENT_SEED`  | Server wallet (receives XRP). Optional on testnet.     |
| `PAYER_SEED`      | Client wallet (sends XRP). Optional on testnet.        |
| `XRPL_NETWORK`    | `testnet` (default), `devnet`, or `mainnet`.           |
| `PORT`            | Server port. Default `3000`.                           |
| `AGENT_PRICE_DROPS_PER_1K_TOKENS` | Pricing knob. Default `100000` (0.1 XRP). |

> **Do NOT do this in production.**
>
> Reading raw seeds out of `.env` is fine for local testing on testnet,
> but it is **not** how a real service should hold keys.
>
> For production:
> - Use a KMS / HSM / cloud secret manager (AWS KMS, GCP KMS, HashiCorp
>   Vault, Azure Key Vault, ...) and inject signing capability — never
>   the seed itself — into the process.
> - Or run the wallet in a separate signer service the agent talks to
>   over an authenticated channel.
> - Keep the recipient (server) wallet hot only for the funds it needs
>   to settle protocol-level operations; sweep balances to cold storage
>   on a schedule.
> - Rate-limit and authenticate the agent endpoint at the application
>   layer — payment is not a substitute for authn/authz when the same
>   payer should be allowed multiple uses.

## Files

```
examples/agent-template/
├── README.md           — this file
├── package.json        — standalone deps (so the folder can be lifted out)
├── tsconfig.json
├── .env.example
├── .gitignore
└── src/
    ├── env.ts          — wallet + config loading
    ├── intent.ts       — Zod schema for the payment intent + pricing
    ├── agent.ts        — mock LLM "agent" (replace with your real one)
    ├── server.ts       — Express + MPP charge endpoint
    ├── client.ts       — TS client paying the intent
    └── run-demo.ts     — one-command orchestrator (server + client)
```

## What you replace to make it real

1. `src/agent.ts` — swap the mock `runAgent()` for your real LLM /
   tool / data call.
2. `src/intent.ts` — adjust the `PaymentIntent` schema and `priceOf()`
   to match what you actually charge for.
3. `src/env.ts` — replace `loadWallets()` with a KMS-backed signer
   before deploying anywhere that touches mainnet.
4. Add authentication, rate-limiting, observability, and an MPP
   `Store` backed by a real database (`Store.memory()` is process-local).
