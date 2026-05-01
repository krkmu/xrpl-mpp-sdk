# xrpl-mpp-sdk audit -- 2026-05-01

Pulled fresh upstream:

- `_reference/mppx` -> HEAD `164e2a2 fix(tempo): block session charges after channel force-/pending close`
- `_reference/stellar-mpp-sdk` -> HEAD `5472bdb feat(charge): create end-to-end tests for the Charge intent (#41)`

Both repos pulled fast-forward, no local changes to stash.

Baseline (main, before this session):

- `pnpm vitest run` -> 141 tests pass, 13 files
- `pnpm tsc --noEmit` -> clean
- `pnpm biome check` -> 1 warning (unused `lastSig` in `test/security/integration.test.ts:842`)
- All tests are unit-style mocks. **Zero tests hit a real ledger.** No devnet integration suite exists.

## 1. Module-by-module state

### `sdk/src/Methods.ts` (charge schema)
- Method.from registered as `{ name: 'xrpl', intent: 'charge' }`
- Discriminated union `transaction | hash` for credential payload
- Request fields: amount, currency, recipient, description, externalId, methodDetails {reference, network, invoiceId}
- **Tested:** schema parse for both modes, request shape, reject non-numeric/non-hex
- **Missing:** no length/format validation on `blob`/`hash` (stellar caps XDR at 8KB); no validation that recipient is a valid r-address or x-address; no destinationTag, sourceTag, memos surface in schema

### `sdk/src/channel/Methods.ts` (channel schema)
- Method.from registered as `{ name: 'xrpl', intent: 'channel' }`
- Three-action union: `open | voucher | close`
- Request fields: amount, channelId, recipient, description, externalId, methodDetails {reference, network, cumulativeAmount}
- **Missing:** signature length not pinned (xrpl ed25519 sig is 128 hex; secp256k1 is variable but bounded). No validation that channelId is exactly 64 hex chars in the schema (only regex `\d+` for amount). No upper bound on transaction blob size.

### `sdk/src/client/Charge.ts`
- Builds Payment tx (autofill, sign), pull/push, optional preflight
- onProgress callback for lifecycle events
- **Source DID format:** `did:pkh:xrpl:{network}:{address}` -- correct
- **Missing:** no destinationTag/sourceTag/InvoiceID/memos at the request level (only InvoiceID via methodDetails)
- **Missing:** no path autofill for IOU payments (ripple_path_find). Many real-world IOU payments need a path; without one, payment fails with tecPATH_DRY.
- **Missing:** no LastLedgerSequence bound respecting `challenge.expires` (challenge expiry is not enforced on-chain)

### `sdk/src/server/Charge.ts`
- Verifies pull (decode blob, validate, submit, poll) and push (lookup hash on chain)
- Replay protection via `xrpl:tx:{hash}` and `xrpl:challenge:{id}` keys, two-stage pending->confirmed
- TOCTOU mitigation by `verifyLock` Promise serializer (single-process only)
- Validates Destination, Amount, currency match, InvoiceID
- Rejects `tfPartialPayment`
- **Missing: did:pkh source verification.** Stellar verifies the credential's `source` DID matches the on-chain transfer's `from` address -- prevents hash-theft (push mode) and source-spoofing (pull mode where an attacker submits someone else's blob). We do not check `tx.Account` matches the credential source. **HIGH PRIORITY.**
- **Missing:** challenge expiry not enforced on-chain through LastLedgerSequence comparison
- **Missing:** no claim-set TOCTOU layer (stellar-mpp-sdk uses a synchronous `Set` keyed by store reference for intra-process safety on top of `verifyLock`). Less critical now since `verifyLock` covers single-process, but adding it costs little and matches stellar's pattern.
- **Missing:** no logger abstraction; verification failures are completely silent

### `sdk/src/channel/client/Channel.ts`
- `channel()` for credential creation (open/voucher/close)
- `openChannel()` and `fundChannel()` helpers (PaymentChannelCreate, PaymentChannelFund)
- Open flow: signs claim with placeholder channelId(`0`*64), server replaces with real id
- **Missing:** open flow's "placeholder signature" silently falls back to cumulative=0 in the server when the placeholder doesn't match the real channelId. We should reject explicitly or have the server pre-extract channelId via simulation/prepare and the client re-sign.
- **Missing:** no pre-flight reserve check before submitting PaymentChannelCreate (each channel adds an owner object, requires an extra reserve increment)
- **Missing:** `openChannel`/`fundChannel` don't fail-fast on `tecINSUFFICIENT_RESERVE` -- the raw error bubbles up

### `sdk/src/channel/server/Channel.ts`
- Verifies claim signature via `verifyPaymentChannelClaim`
- Tracks cumulative in store; rejects equal (replay) or lower (attack)
- Optional `verifyChannelOnChain` checks channel existence, expiration, balance
- Open flow: broadcasts client-signed PaymentChannelCreate, polls, extracts channelId, stores
- Close flow: submits PaymentChannelClaim (with tfClose if caller is source)
- **Missing: source DID verification.** Stellar verifies the channel's `Account` matches the credential's source. We bind to the configured `publicKey` only, but never check who *sent* the credential.
- **Missing: dispute escalation on reserve exhaustion.** When a channel runs out, we throw AMOUNT_MISMATCH. Should be a dedicated error.
- **Missing:** `verifyChannelOnChain: false` is the default. With this off, an attacker can submit a valid signature for a channel that does not exist or that they don't own. The local replay store catches duplicates but not freshly fabricated channels. **Should default to true** (or at least once-per-channel verification cached in store).

### `sdk/src/utils/trustline.ts`
- `ensureTrustline()` creates trustline if `autoTrustline=true`
- `checkRippling()` reads `lsfDefaultRipple` flag on issuer
- **Missing:** does not check `lsfGlobalFreeze` on issuer or per-trustline freeze (`HighFreeze`/`LowFreeze`) which prevent IOU transfers
- **Missing:** does not check `lsfNoFreeze` (issuer can never freeze) which is a positive trust signal
- **Missing:** does not check `lsfRequireAuth` on issuer (asfRequireAuth) which means trustlines need explicit auth from issuer before they can hold balance
- **Missing:** no reserve check before issuing TrustSet

### `sdk/src/utils/mpt.ts`
- `ensureMPTHolding()` submits `MPTokenAuthorize` if needed
- **Missing:** does not detect issuer's `lsfMPTRequireAuth` -- when set, holders need a *paired* MPTokenAuthorize from the issuer side, not just the holder side. Otherwise payments fail with tecNO_AUTH despite authorization
- **Missing:** does not check the issuance still exists (could be destroyed)
- **Missing:** no reserve check before MPTokenAuthorize

### `sdk/src/utils/validation.ts`
- Verifies destination exists, balance covers reserves+fees+payment, rippling enabled for IOU
- **Missing:** balance check does not factor in *future* owner objects added by the same flow (e.g., if `autoTrustline` will trigger, we don't pre-add 1 reserve_inc to the requirement)
- **Missing:** does not consider IOU-specific balance (only XRP) -- for IOU sends, we should verify the sender's IOU balance via `account_lines`
- **Missing:** does not consider MPT balance for MPT sends

### `sdk/src/errors.ts`
- Maps tec/tem/ter results to SDK error codes
- Wraps in mppx Errors classes (VerificationFailedError, InsufficientBalanceError, etc.)
- **Missing tec mappings:**
  - `tecNO_PERMISSION` -> not mapped (used by MPT for unauthorized; should map to `MPT_NOT_AUTHORIZED` or similar)
  - `tecNO_AUTH` already maps but only to TRUSTLINE -- in MPT context it's a permission error
  - `tecINSUF_FEE` -> not mapped (only `terINSUF_FEE_B`)
  - `tecPATH_PARTIAL` maps to `INSUFFICIENT_BALANCE` -- semantically wrong; should be `PAYMENT_PATH_FAILED` since the issue is path liquidity, not the sender's balance
  - `tecPATH_DRY` does map to PAYMENT_PATH_FAILED -- correct
- **Missing:** no `SettlementError` distinct from `VerificationFailedError` (stellar separates these, useful for retry decisions)

### `sdk/src/channel/stream.ts`
- ChannelStream (pay-per-token) and ChannelSession (per-request)
- **Missing:** no integration test against a real channel
- **Missing:** stream private key field uses `#privateKey` but is leaked through any Error toString since it's a regular field; spot-check.

### Tests
- `test/compliance/` -- 3 files, schema/interop/protocol; all mocks
- `test/security/` -- 5 files; replay, tamper, input-validation, channel-auth, integration; all unit-level (real crypto but no ledger)
- `test/xrpl/` -- 5 files; charge/channel/dual-curve/mpt/trustline; all mocks (assertions on ranges, codes, parsing -- not on real submitted txs)
- `test/utils/test-helpers.ts` -- has `createTestWallet` etc. but **no test file currently imports it**. Dead code.
- **Missing:** no integration suite that funds wallets, opens channels, and verifies real on-chain transactions
- **Missing:** edge case suite (reserve exhaustion, freeze, partial payment, expired channel, dust amount)
- **Missing:** coverage threshold and reporting

## 2. Spec conformance gaps (vs `_reference/mppx` and `_reference/stellar-mpp-sdk`)

| Area | Behaviour today | Spec/Stellar reference | Type |
|---|---|---|---|
| Source DID verification | Not checked. Server trusts whatever Account is on the tx. | Stellar `publicKeyFromDID()` extracts pubkey from credential.source and asserts it matches the tx's `from`. | **Bug** |
| Two-layer claim TOCTOU | Only Promise-based `verifyLock`. | Stellar uses sync `claimOrThrow` Set + verifyLock. | **Missing** |
| Polling abstraction | Ad-hoc linear sleep loops in 2 places. | Stellar `pollTransaction` with backoff+jitter+semaphore. | **Missing** (deviation, intentional simplicity but DoS risk) |
| Settlement vs Verification errors | Both use `VerificationFailedError`. | Stellar separates `PaymentVerificationError` and `SettlementError`. | **Missing** -- intentional simplification, will not change |
| Logger abstraction | None. | Stellar pluggable `Logger` (pino-compatible). | **Missing** -- production hardening |
| `Method.from` schema | Matches mppx pattern exactly. | Same. | **PASS** |
| Receipt format | Uses `Receipt.from({ method: 'xrpl', reference, status, timestamp, externalId? })`. | Same. | **PASS** |
| 402 / WWW-Authenticate / Authorization headers | Handled by mppx framework. | Same. | **PASS** |
| Pull/push modes | Discriminator on `type: 'transaction' | 'hash'`. | Same. | **PASS** |
| Channel actions | Three-way union (open/voucher/close) matches stellar exactly. | Same. | **PASS** |
| Credential size cap | 64KB. | Stellar 8KB for XDR. | **Intentional XRPL-specific divergence** -- xrpl signed blobs can be larger than Stellar XDR, but 64KB is generous; should add a comment. |
| Challenge TTL enforcement | 5 min default, configurable. | Same default. | **PASS** |
| Replay store keys | `xrpl:tx:{hash}`, `xrpl:challenge:{id}`, `xrpl:channel:{id}`, `xrpl:channel:finalized:{id}`. | Stellar uses `stellar:{intent}:{type}:{id}`. | **PASS** -- our scheme is fine, just different prefix order |

## 3. XRPL edge case gap list

For each: confirm coverage, write a failing test, fix.

| # | Area | Gap | Test to add | Fix plan |
|---|---|---|---|---|
| X1 | Reserve preflight | TrustSet, MPTokenAuthorize, PaymentChannelCreate do not pre-check that owner reserve will be satisfied. Today only the *payment* path runs preflight. | unit: stub account_info to return balance just below `base + (ownerCount+1)*inc` and assert `INSUFFICIENT_RESERVE` is raised before submit | Extend `runPreflight` with an `addsOwnerObjects` count, factor into balance check. Use it in `ensureTrustline`, `ensureMPTHolding`, `openChannel`. |
| X2 | Trustline freeze / global freeze | If issuer set lsfGlobalFreeze, IOU sends fail with tecPATH_DRY. We give the user a generic path-failed error. | unit: mock issuer Flags = lsfGlobalFreeze and assert clear `ISSUER_GLOBAL_FROZEN` error from preflight | Add freeze checks to `checkRippling` (rename to `checkIssuerHealth`); raise typed error |
| X3 | RequireAuth (trustline) | Issuer with asfRequireAuth requires authorization on the trustline. Without it, payments fail tecNO_AUTH. We don't pre-check. | unit: mock issuer with asfRequireAuth set; assert `TRUSTLINE_REQUIRES_AUTH` | Add to `ensureTrustline`: detect, throw typed error with actionable message |
| X4 | MPT issuance auth check | When issuer has lsfMPTRequireAuth, holder needs both sides authorised. We only do holder side. | unit: mock issuance with `MPTokenIssuance.Flags & lsfMPTRequireAuth`; assert SDK throws | Detect via `ledger_entry MPTokenIssuance`, surface clear error; auto-handle requires issuer-side seed which we don't have, so throw with actionable message |
| X5 | IOU paths | We never set `Paths` on Payment for IOU. Many cross-issuer or rippling-required paths fail. | unit: mock ripple_path_find returning a path; assert client uses it. integration: pay an IOU through a path | Use `client.request({ command: 'ripple_path_find', ... })` when currency is IOU and source != issuer; attach `Paths` to tx |
| X6 | Failure mapping enrichments | tecPATH_PARTIAL -> currently INSUFFICIENT_BALANCE (wrong); tecNO_PERMISSION not mapped; tecINSUF_FEE not mapped. | unit: assert each mapping | Update `TEC_RESULT_MAP` and add `MPT_NOT_AUTHORIZED` for tecNO_PERMISSION when MPT context |
| X7 | Source/Destination tags | Not exposed at all. | unit: pass sourceTag/destinationTag in challenge methodDetails; assert tx contains them | Extend charge schema's `methodDetails` to include `sourceTag`, `destinationTag`. Plumb through client. Server validates on push verification too. |
| X8 | Memos | Not exposed. | unit: pass memos in methodDetails; assert tx contains them | Same as X7. |
| X9 | Channel dust | Channel amount below MinReserve (or below network's drops dust threshold) silently fails on submit. | unit: openChannel with amount=0 or below 1 drop; assert typed error | Add validation in `openChannel`: amount must be >= 1 drop, plus cumulative claim must respect channel reserve. |
| X10 | Channel expiration / CancelAfter | Server checks `channelObj.Expiration` only when verifyChannelOnChain=true. Default off. | unit: stub `lookupChannel` returning expired channel; assert `CHANNEL_EXPIRED` | Default `verifyChannelOnChain` to `true` (cached after first hit per channelId in store) -- safety win at cost of one RPC per channel |
| X11 | Channel exhaustion | Cumulative > channel Amount today raises AMOUNT_MISMATCH. Should be its own error. | unit: same setup, distinct error | Add `CHANNEL_EXHAUSTED` error code, throw it specifically when newCumulative > channelBalance |
| X12 | Partial payment defense | Already rejected via `tfPartialPayment` flag check. | unit: already covered. | No change. |
| X13 | InvoiceID | Already supported via methodDetails. | unit: already covered. | No change. |
| X14 | LastLedgerSequence respects challenge.expires | Today challenge.expires is in `request().createdAt + maxChallengeAge` only. tx may stay valid on-chain past expires. | unit: build tx with autofill; assert LastLedgerSequence is bounded by challenge expiry | Pass challenge.expires into client; constrain LastLedgerSequence accordingly |

## 4. Proposed PR sequence

Each PR is small, atomic, reviewable. I'll make them as commits on `session/2026-05-01-production-grade`; can be split into branches by cherry-pick later.

1. **chore: clean up lint warning, gitignore docs**
2. **feat(server): verify did:pkh source matches tx.Account (charge + channel)** -- closes hash-theft. (X-spec)
3. **feat(channel): default verifyChannelOnChain=true with cached fast-path** -- closes channel-fabrication. (X10)
4. **feat(reserves): owner-reserve-aware preflight for trustline/MPT/channel ops** (X1)
5. **feat(trustline): detect global freeze, RequireAuth, NoFreeze and surface typed errors** (X2, X3)
6. **feat(mpt): detect lsfMPTRequireAuth and surface typed error** (X4)
7. **feat(paths): autofill IOU Paths via ripple_path_find** (X5)
8. **feat(errors): improve tecResult mapping (tecPATH_PARTIAL, tecNO_PERMISSION, tecINSUF_FEE)** (X6)
9. **feat(metadata): support sourceTag, destinationTag, memos in challenge and credential** (X7, X8)
10. **feat(channel): dust + exhaustion + expiration typed errors; default expiration check** (X9, X10, X11)
11. **feat(charge): bound LastLedgerSequence to challenge.expires** (X14)
12. **test(integration): real devnet integration suite (auto-funded ephemeral wallets) + edge case suite**
13. **ci: split into unit + integration jobs; add coverage threshold (vitest --coverage)**
14. **docs(security-pass): security pass results -- key handling review**

## 5. Out of scope (this session)

- README / public docs updates (user requested no doc churn this round)
- Stream reliability hardening (ChannelStream loss detection)
- Pluggable logger (would be added in a follow-up)
- SettlementError split (intentional simplicity choice; current users get one error type)

