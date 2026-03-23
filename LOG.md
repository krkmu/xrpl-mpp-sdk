# Issue Fix Log

> Tracking all fixes for the 17 open issues on xrpl-mpp-sdk.
> Each fix gets its own branch and will become a PR on merge.

---

## Status

| GitHub Issue | Title | Severity | Branch | Status |
|---|-------|----------|--------|--------|
| #2 | Partial Payment attack | High | `fix/issue-2` | Done |
| #3 | Replay protection silent disable | Medium | `fix/issue-3` | Done |
| #4 | TOCTOU race in store dedup | Medium | `fix/issue-4` | Done |
| #5 | Pull mode dedup before submit | Medium | `fix/issue-5` | Done |
| #6 | Auto-trustline excessive limit | Medium | `fix/issue-6` | Done |
| #7 | Missing currency validation | Low | `fix/issue-7` | Done |
| #8 | No challenge TTL | Low | `fix/issue-8` | Done |
| #9 | Schema accepts empty strings | Low | `fix/issue-9` | Done |
| #10 | Silent network error swallowing | Low | `fix/issue-10-real` | Done |
| #11 | No on-chain channel verification | Low | `fix/issue-10` | Done |
| #12 | No payload size limits | Low | `fix/issue-11` | Done |
| #13 | Hardcoded polling params | Low | `fix/issue-12` | Done |
| #14 | ChannelStream.privateKey public | Info | `fix/issue-16` | Done |
| #15 | No CI/CD pipeline | Info | `fix/issue-14` | Done |
| #16 | lookupChannel swallows errors | Info | `fix/issue-15` | Done |
| #17 | Security tests shallow | Info | `fix/issue-17` | Done |
| #18 | InvoiceID not verified | Info | `fix/issue-18` | Done |

Note: #13 is a duplicate of #12 (same FINDING-12). Will close as duplicate.

---

## Fix Details

### #2 -- [HIGH] Partial Payment attack defense
**Branch:** `fix/issue-2`
**Files changed:** `sdk/src/server/Charge.ts`, `test/xrpl/charge.test.ts`
**Changes:**
- Added `rejectPartialPayment()` -- rejects tx with `tfPartialPayment` flag (0x00020000)
- `validatePaymentFields` now uses `meta.delivered_amount` when available (push mode)
- Added tests for partial payment flag detection and delivered_amount precedence

### #3 -- [MEDIUM] Replay protection require Store
**Branch:** `fix/issue-3`
**Files changed:** `sdk/src/server/Charge.ts`, `sdk/src/channel/server/Channel.ts`
**Changes:**
- Added `requireStore` option (default: `true`) to charge and channel server
- Throws clear error if store is missing and requireStore is not explicitly false

### #4 -- [MEDIUM] TOCTOU race in store-based dedup
**Branch:** `fix/issue-4`
**Files changed:** `sdk/src/server/Charge.ts`, `sdk/src/channel/server/Channel.ts`
**Changes:**
- Mark tx hash as "pending" in store immediately before on-chain verification
- Update to "confirmed" after successful verification
- Documented distributed deployment limitation for channel cumulative tracking

### #5 -- [MEDIUM] Pull mode dedup before submit
**Branch:** `fix/issue-5`
**Files changed:** `sdk/src/server/Charge.ts`
**Changes:**
- Import `hashes` from xrpl.js
- Use `hashes.hashSignedTx(blob)` to derive tx hash before `client.submit()`
- Move dedup check before network call

### #6 -- [MEDIUM] Auto-trustline configurable limit
**Branch:** `fix/issue-6`
**Files changed:** `sdk/src/utils/trustline.ts`, `sdk/src/utils/validation.ts`, `sdk/src/client/Charge.ts`, `sdk/src/types.ts`
**Changes:**
- Changed default trustline limit from 1 billion to 10,000
- Added `autoTrustlineLimit` option to `ChargeClientConfig`
- Threaded through `runPreflight` -> `ensureTrustline`

### #7 -- [LOW] Currency type validation
**Branch:** `fix/issue-7`
**Files changed:** `sdk/src/server/Charge.ts`
**Changes:**
- `validatePaymentFields` now takes `expectedCurrency: XrplCurrency`
- Validates currency, issuer, mpt_issuance_id match challenge for IOU/MPT
- Prevents paying with different currency at same numeric amount

### #8 -- [LOW] Challenge TTL enforcement
**Branch:** `fix/issue-8`
**Files changed:** `sdk/src/server/Charge.ts`, `sdk/src/channel/server/Channel.ts`
**Changes:**
- Added `maxChallengeAge` option (default: 5 minutes) to charge and channel
- Checks `challenge.createdAt` timestamp against max age

### #9 -- [LOW] Schema rejects empty strings
**Branch:** `fix/issue-9`
**Files changed:** `sdk/src/Methods.ts`, `test/security/input-validation.test.ts`
**Changes:**
- Added `minLength(1)` checks to amount, currency, recipient in charge schema
- Updated tests to verify empty strings are rejected at schema level

### #10 -- [LOW] Network error handling in utility functions
**Branch:** `fix/issue-10-real`
**Files changed:** `sdk/src/utils/trustline.ts`, `sdk/src/utils/mpt.ts`
**Changes:**
- `checkTrustline`: only return false for `actNotFound`, re-throw network errors
- `checkRippling`: only return false for `actNotFound`, re-throw network errors
- `checkMPTHolding`: only return false for `actNotFound`, re-throw network errors

### #11 -- [LOW] On-chain channel state verification
**Branch:** `fix/issue-10`
**Files changed:** `sdk/src/channel/server/Channel.ts`
**Changes:**
- Added `verifyChannelOnChain` option (default: false) to channel server
- When enabled: checks channel existence, balance, and expiration on-chain
- Uses `lookupChannel()` to fetch channel state before accepting claims

### #12 -- [LOW] Payload size limits
**Branch:** `fix/issue-11`
**Files changed:** `sdk/src/server/Charge.ts`
**Changes:**
- Added `maxCredentialSize` option (default: 64KB) to charge server
- Rejects oversized credentials before processing

### #13 -- [LOW] Configurable polling parameters
**Branch:** `fix/issue-12`
**Files changed:** `sdk/src/server/Charge.ts`
**Changes:**
- Added `pollTimeout` (default: 60s) and `pollInterval` (default: 1s) options
- Replaced hardcoded 60-iteration loop with deadline-based polling

### #14 -- [INFO] ChannelStream.privateKey -> private field
**Branch:** `fix/issue-16`
**Files changed:** `sdk/src/channel/stream.ts`
**Changes:**
- Changed `readonly privateKey: string` to `readonly #privateKey: string`
- Updated all internal references to use `this.#privateKey`
- Removed redundant `privateKey` field from `ChannelSession`

### #15 -- [INFO] CI/CD pipeline
**Branch:** `fix/issue-14`
**Files changed:** `.github/workflows/ci.yml` (new file)
**Changes:**
- Added GitHub Actions CI workflow
- Runs type-check, lint, and tests on push and pull requests

### #16 -- [INFO] lookupChannel error handling
**Branch:** `fix/issue-15`
**Files changed:** `sdk/src/channel/server/Channel.ts`
**Changes:**
- Only return null for `entryNotFound` errors
- Re-throw network errors so callers can handle them

### #17 -- [INFO] Integration security tests
**Branch:** `fix/issue-17`
**Files changed:** `test/security/integration.test.ts` (new file)
**Changes:**
- 9 new tests using real xrpl.js crypto (Wallet.generate, signPaymentChannelClaim, verifyPaymentChannelClaim)
- Tests: wrong key rejection, correct key acceptance, tampered amount rejection
- Tests: cumulative lifecycle with store, cumulative decrease attack
- Tests: cross-curve ed25519/secp256k1 verification, cross-curve rejection
- Tests: partial payment flag detection

### #18 -- [INFO] InvoiceID server-side verification
**Branch:** `fix/issue-18`
**Files changed:** `sdk/src/server/Charge.ts`
**Changes:**
- Extract `invoiceId` from `challenge.request.methodDetails`
- Validate `tx.InvoiceID` matches expected value when present
- Strengthens challenge-to-payment binding

---

## Verification

All branches verified with:
- `pnpm check:types` -- TypeScript compilation clean
- `pnpm biome check --write .` -- No lint issues
- `pnpm vitest run` -- All tests passing (105-114 tests depending on branch)

## Notes

- Vitest was downgraded from 4.1.0 to 3.2.4 (rolldown native binding issue on darwin-arm64)
- Issue #13 is a duplicate of #12 (both are FINDING-12)
