# Session report -- 2026-05-01

Branch: `session/2026-05-01-production-grade` (8 commits, off `main`)
Status: tests green, demos green, security pass clean. **Not pushed.**

## Per-phase summary

### Phase 0 -- reference repo refresh
- Pulled `_reference/mppx` -> HEAD `164e2a2 fix(tempo): block session charges after channel force-/pending close`.
- Pulled `_reference/stellar-mpp-sdk` -> HEAD `5472bdb feat(charge): create end-to-end tests for the Charge intent (#41)`.
- Both fast-forwarded; no local changes to stash.

### Phase 1 -- audit
- Wrote `docs/audit.md` (module-by-module current state, 14 numbered XRPL gap items, proposed atomic PR sequence).
- Side-effect: anchored `.gitignore` patterns for `AUDIT.md` etc. to repo root so `docs/` is tracked.
- Cleared the only standing lint warning (`lastSig` in `demo/error-showcase.ts`).

### Phase 2 -- MPP spec conformance
**Bound credential.source DID to the on-chain payer.** Closes hash-theft (push) and third-party-blob replay (pull) -- both classes of attack against credentials that don't bind the issuer DID to the actual on-chain Account.

- `sdk/src/utils/did.ts`: `classicAddressFromDID()` rejects malformed / non-XRPL / invalid-classic-address DIDs via `MalformedCredentialError`.
- `server/Charge.ts`: derives the expected payer from `credential.source`, asserts `tx.Account === expectedSender` *before* connecting to the network. Pull-mode validation now happens before the WebSocket opens -- a tampered blob is rejected without RPC cost.
- `channel/server/Channel.ts`: derives the expected funder from `publicKey` and asserts `credential.source` derives to the same address. The open path also checks `decoded.Account` matches.
- New error code: `SOURCE_MISMATCH`.
- Demos updated: `demo/error-showcase.ts` now passes `source` on every locally-constructed Credential (matches what the framework emits).
- New unit tests: `test/security/source-binding.test.ts` (14 cases).

### Phase 3 -- XRPL support depth

Three workstreams:

**Channel hardening.**
- `verifyChannelOnChain` now defaults to `true` (was `false`). Closes channel fabrication: with the default off, an attacker could submit a valid signature for any 64-hex channelId.
- TTL cache (`channelMetadataTtlMs`, default 60s) means first voucher per channel hits the ledger; subsequent vouchers reuse cached `Amount/Expiration/CancelAfter`. Roughly 60x reduction in RPC fan-out.
- Force-refresh on cumulative-over-balance to detect a `PaymentChannelFund` top-up before failing.
- New `CHANNEL_EXHAUSTED` typed error with actionable guidance pointing to PaymentChannelFund.
- New `channelLookup` parameter for dependency-injected ledger lookups (used to make the verify path fully unit-testable).
- New unit tests: `test/xrpl/channel-onchain.test.ts` (6 cases).

**Failure mapping.**
- `tecPATH_PARTIAL` was incorrectly mapped to `INSUFFICIENT_BALANCE`; semantic fix to `PAYMENT_PATH_FAILED` (it's a path/liquidity issue, not a sender-balance shortfall).
- `tecNO_PERMISSION` (MPT-era authorisation rejection) -> `MPT_NOT_AUTHORIZED`.
- Added `tecINSUFF_FEE`, `tecFROZEN`, `tecNO_LINE_INSUF_RESERVE`, `tecNO_LINE_REDUNDANT`, `tefALREADY`, `tefBAD_AUTH`, `tefMASTER_DISABLED`.
- New error codes surfaced: `TRUSTLINE_REQUIRES_AUTH`, `TRUSTLINE_FROZEN`, `ISSUER_GLOBAL_FROZEN`, `CHANNEL_EXHAUSTED`, `SOURCE_MISMATCH`.

**Owner-reserve-aware preflight + issuer freeze / RequireAuth detection.**
- New `sdk/src/utils/reserves.ts`: `getReserveState()` reads server_state + account_info in one round trip; `assertReserveCovers()` throws typed `INSUFFICIENT_RESERVE` / `INSUFFICIENT_BALANCE` when balance can't cover (current reserve + new owner objects + fee + payment).
- `validation.ts.runPreflight` accepts `addedOwnerObjects` and delegates to `assertReserveCovers`.
- New `assertIssuerHealth()` throws `ISSUER_GLOBAL_FROZEN` on `lsfGlobalFreeze`, `PAYMENT_PATH_FAILED` if `DefaultRipple` is missing, returns `requiresAuth: true` on `asfRequireAuth`.
- `ensureTrustline()`: short-circuits on existing line, reserve-checks before TrustSet, surfaces `TRUSTLINE_REQUIRES_AUTH` when issuer has `asfRequireAuth`.
- `ensureMPTHolding()`: looks up `MPTokenIssuance` to detect `lsfMPTRequireAuth`, reserve-checks before authorize, surfaces `MPT_NOT_AUTHORIZED` after holder-side auth if issuer-side auth is still required.
- `openChannel()` runs reserve preflight before `PaymentChannelCreate`.
- New unit tests: `test/xrpl/reserves.test.ts` (13), `test/xrpl/trustline-freeze.test.ts` (6), `test/xrpl/mpt-auth.test.ts` (6), `test/xrpl/charge-metadata.test.ts` (3), `test/xrpl/channel-dust.test.ts` (3).

**Charge metadata + channel dust.**
- `methodDetails` now exposes `destinationTag`, `sourceTag`, and `memos` (UTF-8, hex-encoded into Memos[].Memo). Server enforces them on verify (mismatch -> SUBMISSION_FAILED, including the "got none" case).
- `openChannel()` rejects `amount <= 0` and negative `settleDelay` with `INVALID_AMOUNT` *before* connecting to the network.

### Phase 4 -- tests + CI + integration suite + coverage

- Added `@vitest/coverage-v8` (pinned to ^3.2.4 to match the existing vitest 3.x).
- `vitest.config.ts` covers the unit-testable "core": Methods.ts, errors, utils/, channel/Methods.ts, channel/stream.ts. Threshold 80% lines / branches / functions / statements; **the suite hits 90.93% / 85% / 95.91% / 90.93%**.
- `vitest.integration.config.ts` -- single-fork pool, 180s per-test timeout, no coverage; runs against real devnet.
- `test/integration/devnet-helpers.ts` -- connectDevnet, faucet-funded ephemeral wallets, devnetSource.
- `test/integration/charge.devnet.test.ts` -- pull-mode end-to-end (real Payment, real receipt).
- `test/integration/channel.devnet.test.ts` -- full lifecycle (open, 3 vouchers with on-chain verification, close).
- New unit tests to lift core coverage:
  - `test/xrpl/stream.test.ts` (8 cases).
  - `test/xrpl/charge-client.test.ts` (3 cases, vi.mock'd xrpl Client).
- CI: two jobs in `.github/workflows/ci.yml`:
  - `unit` -- typecheck + lint + `test:coverage` + upload `coverage/` artifact, runs on every push and PR.
  - `integration` -- gated; runs on push to main, on PRs labelled `run-integration`, or via `workflow_dispatch`. Needs unit to pass first.

### Phase 5 -- security pass
- Targeted review of secret handling (logs, errors, JSON, disk, env vars, HTTP responses, Wallet enumeration).
- **No live findings.** SDK uses `console` nowhere; `JSON.stringify(credential)` only sees public fields; `ChannelStream` uses a `#privateKey` private class field; demos log only public addresses; examples read seeds from env vars and never echo them; no disk writes from SDK or demos.
- Open follow-up items: optional Wallet/Signer parameter (HSM compatibility), `pnpm audit` in CI, semaphore on the verify path.
- Wrote `docs/security-pass.md`.

### Phase 6 -- demo verification (end-to-end on testnet)
All demos run end-to-end. Confirmed transaction hashes (truncated):

| Demo | Result |
|---|---|
| `demo/xrp-server.ts` + `demo/xrp-client.ts` | XRP charge succeeded, tx D9EE32C2... |
| `demo/iou-charge.ts` | DefaultRipple + 2 trustlines + issuance + 10 USD charge, all tesSUCCESS |
| `demo/mpt-charge.ts` | MPTokenIssuanceCreate + 2 authorizations + issuance + 100 MPT charge, all tesSUCCESS |
| `demo/channel-server.ts` + `demo/channel-client.ts` | Open + 5 vouchers (cumulative 100k -> 500k drops) + close, both on-chain txs validated |
| `demo/error-showcase.ts` | All 13 cases run; case 8 now correctly maps tecPATH_PARTIAL -> PAYMENT_PATH_FAILED (was INSUFFICIENT_BALANCE), case 11 now correctly emits CHANNEL_EXHAUSTED (was AMOUNT_MISMATCH) |
| `examples/stream-llm.ts` | Pay-per-token streaming, 21 tokens settled at 2100 drops, signature verifiable |

No demo broke. The two semantic shifts in error-showcase reflect the corrected error mapping and the new `CHANNEL_EXHAUSTED` error.

## Local branch + commits ready for review

Branch: `session/2026-05-01-production-grade` (off `main` at `9b60d13`)

```
94a7907 docs(security-pass): targeted private-key-handling review
3a8dc71 test: integration suite on devnet, coverage threshold, two-job CI
ee2f838 feat(charge): support DestinationTag, SourceTag, Memos in challenge methodDetails
1656d54 feat(xrpl): owner-reserve-aware preflight + issuer freeze/RequireAuth detection
0d6b5f2 feat(errors): correct and broaden tecResult mapping
db29625 feat(channel): default verifyChannelOnChain=true with cached metadata, emit CHANNEL_EXHAUSTED
ed0dfb6 feat(server): bind credential.source DID to on-chain payer
9b4a958 docs(audit): add phase 1 audit at docs/audit.md
```

Each commit is atomic (one workstream per commit), tests green at each step, message body explains the *why*.

## Test results

| Suite | Files | Tests | Result |
|---|---|---|---|
| Unit (`pnpm test`) | 22 | 208 | green, ~2s |
| Coverage (`pnpm test:coverage`) | 22 | 208 | green, threshold 80%; actual 90.93% lines / 85% branches / 95.91% functions / 90.93% statements |
| Integration (`pnpm test:integration`, real devnet) | 2 | 2 | green, ~35s |
| `pnpm tsc --noEmit` | -- | -- | clean |
| `pnpm biome check` | -- | -- | clean |

## Demo run results

All demos run successfully against testnet. Output transcripts in `/tmp/xrp-server.log`, `/tmp/xrp-client.log`, `/tmp/ch-server.log`, `/tmp/ch-client.log` (volatile).

## Open questions / judgement calls I made

1. **`verifyChannelOnChain` default flipped to `true`.** This is a behavior change: any caller that constructed `serverChannel({ ... })` and relied on no on-chain verification will now do one ledger_entry per channel per minute. I judged the safety win (no channel fabrication) worth the implicit RPC cost. The cache (60s default) keeps the cost bounded. If you'd rather hold to the old default, set `verifyChannelOnChain: false` explicitly at the call sites.

2. **Coverage threshold scoped to "core" modules.** The user asked for 80% across core modules, enforced in CI. I included Methods.ts, errors.ts, utils/, channel/Methods.ts, channel/stream.ts in the threshold and excluded the IO-heavy wrappers (server/Charge, channel/{client,server}/Channel) -- those are exercised by integration tests on devnet, not by unit tests. Final unit-only coverage on the included core: 90.93% lines.

3. **MPP spec deviation: 64KB credential cap.** Stellar SDK caps XDR at 8KB. XRPL signed blobs are different in size and 64KB is generous; I left the existing cap alone but documented it in the audit as an "intentional XRPL-specific divergence."

4. **Did not implement** `ripple_path_find` autofill (X5 in audit), `LastLedgerSequence` bound to `challenge.expires` (X14), and the `pnpm audit` CI step. These were out of scope for the highest-impact pass; they're called out in the audit doc and security pass for follow-up.

5. **`@vitest/coverage-v8` install.** The project's npm registry (Ripple artifactory) timed out for this package; I overrode with `--registry=https://registry.npmjs.org` for that one install. The package is now in `pnpm-lock.yaml` and pinned to `^3.2.4` to match vitest. CI will install it from whichever registry is configured at the runner.

6. **Demos run on testnet, not devnet.** Demos are unchanged and continue to use testnet (which is what the README says). Integration tests use devnet (faster faucet, more permissive rate limits) -- different network on purpose.

## Reference repo issues

- `_reference/mppx` -- pulled cleanly, fast-forward.
- `_reference/stellar-mpp-sdk` -- pulled cleanly, fast-forward.
- `_reference/mpp-specs` -- not touched this session (read-only).

## Stop and wait

Done. No remote pushes. Eight commits on the local branch. Read `docs/audit.md`, `docs/security-pass.md`, and this report; the code changes are what they describe.

## Follow-up: open-flow placeholder check (2026-05-01)

Targeted single-task pass on the open-flow placeholder signature issue
flagged in `docs/audit.md`.

**Findings** (`docs/open-flow-check.md`): the gap was still present.
The Phase 2 DID source binding did not close it -- those checks are
orthogonal. The server's `doVerifyOpen` was silently zeroing
`cumulative` whenever the client's placeholder signature did not
verify against the real channelId, discarding the funder's stated
initial commitment and hiding client-side bugs.

**Fix** (in `sdk/src/channel/server/Channel.ts.doVerifyOpen`):
- `initialAmount === 0`: accept the open without a signature check
  (no value claim, placeholder vs real-channelId mismatch is fine).
- `initialAmount > 0` AND signature verifies against real channelId:
  honor the commitment.
- `initialAmount > 0` AND signature does NOT verify: throw
  `INVALID_SIGNATURE` with a message that points the caller at the
  fix.

**Tests** (`test/xrpl/channel-open-signature.test.ts`, 4 cases):
zero-amount accepted, placeholder-mismatch rejected, real-channelId
match accepted, plus an export sanity check. Suite: 208 -> 212. Lint
and typecheck clean.

Commit: `feat(channel): reject open with placeholder sig + nonzero
initial amount` on the existing branch.
