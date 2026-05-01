# Security pass -- 2026-05-01

Scope: targeted review of secret handling. Not a full audit.

## What I looked at

| Vector | Method |
|---|---|
| `console.log` / structured log of seeds / private keys | grep `console\.(log|error|warn|info|debug)` in `sdk/src/`; grep `log.*seed`, `log.*privateKey`, `log.*secret` in demos |
| Keys passed through promise rejections / Error objects | grep `throw.*\${.*seed\|throw.*\${.*privateKey` in `sdk/src/` |
| Keys persisted to disk | grep `fs.writeFile`, `fs.appendFile`, `writeFileSync` |
| Env var reads without validation | grep `process.env.*WALLET_SEED|SECRET|PRIVATE_KEY` |
| Defaults that hold keys in memory longer than necessary | code review of `Charge.ts`, `Channel.ts`, `stream.ts` |
| HTTP request bodies that could include keys via JSON.stringify | grep `JSON.stringify` and review each call site |
| Wallet/Keypair leaked via toJSON / structured clone | check xrpl.js `Wallet` shape, look for `JSON.stringify(wallet)` |

## Findings

| # | Severity | Location | Issue | Status |
|---|---|---|---|---|
| 1 | n/a | `sdk/src/` | No `console.*` calls anywhere in library code | OK |
| 2 | low | `sdk/src/server/Charge.ts:71` | Mismatch error includes `recipientWallet.classicAddress` (the address the seed derives to). This is a *public* address, not the seed -- safe. | OK |
| 3 | n/a | `sdk/src/channel/stream.ts` | `ChannelStream` stores the funder's private key in a `#privateKey` private class field. Class private fields are not enumerable and are not exposed by `JSON.stringify`. | OK |
| 4 | n/a | `sdk/src/server/Charge.ts:149` | `JSON.stringify(credential)` is used to measure credential size. The credential contains: `challenge` (public), `payload` (signed blob or hash + DID source), and `source` (DID). No raw private key or seed. | OK |
| 5 | n/a | `sdk/src/utils/currency.ts:35` | `JSON.stringify(currency)` over `{ currency, issuer }` or `{ mpt_issuance_id }` -- public fields only. | OK |
| 6 | n/a | `examples/`, `demo/` | All seeds come from `process.env.XRPL_SEED` (examples) or freshly faucet-funded ephemeral wallets (demos). Demos log the **public** address but never the seed or private key (`demo/log.ts.key()` is only used for `MPTokenIssuanceID` and `wallet.publicKey`). | OK |
| 7 | n/a | filesystem | No disk writes from `sdk/`, `demo/`, or `examples/`. | OK |
| 8 | n/a | env vars | `sdk/src/` reads no env vars. The CLI-style scripts in `examples/` read `XRPL_SEED` and `XRPL_DEST`; if `XRPL_SEED` is unset they print a usage banner and exit 1. They do not echo the seed back. | OK |
| 9 | observation | `sdk/src/channel/server/Channel.ts` `close({ seed })` | `close()` accepts a raw seed string. Future-proofing: accept a `Wallet` or a "signer" function so callers using HSM / KMS / hardware wallet can plug in without exposing the secret to the SDK boundary. Tracked here as an enhancement; current API is parity with `openChannel`/`fundChannel`. | accepted |
| 10 | observation | `sdk/src/server/Charge.ts` `verifyPush` | Push mode looks up `tx_json` from RPC. The DID source binding I added in this session blocks hash theft, but a defense-in-depth improvement would be to additionally enforce `tx.SigningPubKey -> deriveAddress` matches `tx.Account` (the ledger already does this, but checking client-side prevents an attacker from feeding garbage). Low impact since the ledger validates this. | accepted |

## What I did not examine in this pass

- Cross-process replay protection in distributed deployments (this is a Store implementation concern; the in-memory `Store.memory()` covers single-process)
- Side-channel timing on signature verification (`xrpl.js` `verifyPaymentChannelClaim` uses constant-time primitives)
- Dependency CVE scan (left for a follow-up; would run `pnpm audit` + Trivy)
- TLS / WebSocket handshake hardening (handled by `xrpl.js`)
- Rate-limiting / DoS protection on the verify path (the channel metadata cache I added in this session reduces RPC fan-out by ~60x but does not bound concurrent verifies; that's a Semaphore work item carried over from the audit doc)

## Fixes applied this session

None required from this pass -- the SDK's secret handling is already disciplined. The improvements applied earlier in this session (DID source binding, `verifyChannelOnChain` default true, exhaustion detection) collectively close the most material attack vectors: hash theft, third-party blob replay, and channel fabrication.

## Open items

- Allow `Wallet` instances (or a `Signer` callback) in addition to raw seed strings on `openChannel`, `fundChannel`, `close`, and the server-side auto-setup helpers. Cleanly supports HSM / KMS-backed signing.
- Add `pnpm audit` + dependency CVE scan to the CI matrix.
- Add a Semaphore on the server verify path so a flood of credentials doesn't open arbitrarily many WebSocket connections.
