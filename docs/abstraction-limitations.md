# SDK Abstraction Limitations

Living document tracking gaps where consumers of `xrpl-mpp-sdk` may still need
to reach into `xrpl` directly. The goal is to make this list shrink to zero
over time.

Each entry follows the same shape:

- **Status** -- `open` / `in-progress` / `closed`
- **Scope** -- which user-facing area is affected
- **Why it leaks** -- the underlying reason
- **What it forces the consumer to do** -- concrete xrpl import they must add
- **Proposed fix** -- the API we want once it's closed

---

## 1. Wallet abstraction

### 1.1 `ChannelStream` / `ChannelSession` accept a raw `privateKey`, not a `Wallet`

- **Status**: closed.
- **Scope**: `xrpl-mpp-sdk/channel` -- pay-per-token streaming.
- **What changed**: both constructors now accept `{ wallet: Wallet }`
  (preferred) in addition to `{ privateKey: string }` (kept for backward
  compatibility). The class stores only the resolved private key
  internally via the existing `#privateKey` private field; nothing else
  about the streaming behavior changed. `ChannelStreamSigner` is exported
  from `xrpl-mpp-sdk/channel` for downstream typing.
- **Closed by**: `sdk/src/channel/stream.ts`; tests in
  `test/xrpl/stream.test.ts`.

### 1.2 No SDK helper to prepare a signed `PaymentChannelCreate` blob for the MPP open flow

- **Status**: closed.
- **Scope**: PayChannel open-via-MPP (`action: 'open'` credential).
- **What changed**: `prepareOpenChannelTransaction({ wallet, destination,
  amount, settleDelay, expiresAt?, ... })` is now exported from
  `xrpl-mpp-sdk/channel/client`. It runs the same owner-reserve preflight
  as `openChannel`, autofills the tx, optionally caps `LastLedgerSequence`
  to `challenge.expires`, signs locally, and returns
  `{ txBlob, txHash }` -- ready to drop into the open credential. A
  thin `wallet.signOpenChannelTransaction(...)` method on `Wallet`
  delegates to the same helper for consumers who prefer the
  Wallet-first API. `examples/channel-open-mpp.ts` no longer imports
  from `xrpl` at all.
- **Closed by**: `sdk/src/channel/client/Channel.ts.prepareOpenChannelTransaction`,
  `sdk/src/utils/wallet.ts.Wallet.signOpenChannelTransaction`; tests in
  `test/xrpl/channel-prepare-open.test.ts`.

### 1.3 `Wallet._xrplWallet` is a public-but-internal back door

- **Status**: open (intentional, low-priority)
- **Scope**: anyone reading the type of `Wallet`.
- **Why it leaks**: SDK internals (`runPreflight`, `submitAndWait`,
  `ensureTrustline`, `ensureMPTHolding`) need an actual `xrpl.Wallet` to call
  xrpl.js APIs. The `Wallet` class exposes a getter `_xrplWallet` (prefixed
  `_`, JSDoc `@internal`) so the SDK can reach the underlying handle.
- **What it forces the consumer to do**: nothing -- a consumer that ignores
  underscore-prefixed members never sees an `xrpl.Wallet`. But TypeScript
  does not enforce the convention, so the type leaks `XrplWallet` if someone
  hovers the property.
- **Proposed fix** (later, low priority): hide the handle behind a non-string
  symbol key, or move all internal callers behind a module-private friend
  function so the getter can be removed entirely.

---

## 2. Network / Client abstraction (partially closed)

### 2.1 `xrpl.Client` is still required for any operation outside the chargeable / channel happy paths

- **Status**: partially closed -- trustline / IOU issuance / freeze /
  authorize / clawback / DefaultRipple **and** MPT issuance / accept /
  refuse / authorize / lock / unlock / freeze / clawback / destroy
  **and** escrow create / finish / cancel / list / get are now covered
  by Wallet methods. Each method opens / closes its own short-lived
  xrpl.Client internally so consumers never import `xrpl`.
- **IOU-only**: `Wallet.enableTransfers` / `Wallet.disableTransfers`,
  `Wallet.requireAuthorization` (toggle), `Wallet.allowClawback` (toggle).
  These have no MPT equivalent because MPT flags are immutable per
  protocol -- pass them to `Wallet.createToken` instead.
- **MPT-only**: `Wallet.createToken`, `Wallet.destroyToken`,
  `Wallet.lockToken` / `Wallet.unlockToken`, `Wallet.listIssuedTokens`.
  These have no IOU equivalent because IOU "issuance" is implicit (no
  ledger object to create).
- **Escrow** (XRP today, IOU/MPT after `TokenEscrow`): `Wallet.createEscrow`,
  `Wallet.finishEscrow`, `Wallet.cancelEscrow`, `Wallet.getEscrow`,
  `Wallet.listEscrows`. The `generatePreimageCondition()` helper mints a
  fresh PREIMAGE-SHA-256 condition + fulfillment pair so consumers
  don't pull in a crypto-conditions library. Reserve preflight,
  `FinishAfter` / `CancelAfter` cutoff checks, and on-chain condition
  matching all happen client-side and surface as typed
  `ESCROW_NOT_READY` / `ESCROW_INVALID_FULFILLMENT` /
  `ESCROW_NOT_FOUND` errors. The corresponding `tec*` codes
  (`tecCRYPTOCONDITION_ERROR`, `tecNO_TARGET`) are also mapped through
  `TEC_RESULT_MAP` for any path that bypasses the Wallet preflight.
- **Polymorphic over `IssuedCurrency | MPToken`**: `Wallet.acceptToken`,
  `Wallet.refuseToken`, `Wallet.holdsToken`, `Wallet.listAcceptedTokens`,
  `Wallet.authorize`, `Wallet.freeze` / `Wallet.unfreeze`,
  `Wallet.clawback`, `Wallet.issue`. The SDK dispatches to the right
  XRPL transaction internally based on the runtime shape of the token.
- **Closed by**: `sdk/src/utils/mpt.ts` (rewritten as the source of
  truth for every MPT op, parallel to `utils/trustline.ts`); `Wallet`
  methods in `sdk/src/utils/wallet.ts`. `demo/mpt-charge.ts` no longer
  imports `xrpl` at all -- it goes end-to-end through the SDK.
- **Open**: OfferCreate (DEX), raw queries, NFTs.
- **MPT pre-conditions worth knowing** (immutable per protocol):
  - `Wallet.freeze` on an MPT throws `MPT_LOCK_NOT_ALLOWED` when the
    issuance was not minted with `allowLock: true`.
  - `Wallet.clawback` on an MPT throws `MPT_CLAWBACK_NOT_ALLOWED` when
    the issuance was not minted with `allowClawback: true`.
  - The fix in both cases is to mint a new issuance with the right
    flag -- the SDK error message says so.
- **Escrow pre-conditions worth knowing**:
  - At least one of `finishAfter` or `condition` must be set
    on `createEscrow` (the SDK rejects upfront with `INVALID_AMOUNT`).
  - When both `finishAfter` and `cancelAfter` are set, `finishAfter`
    must be strictly less than `cancelAfter`.
  - Without `cancelAfter`, the escrow can never be cancelled --
    `Wallet.cancelEscrow` throws `ESCROW_NOT_READY` immediately.
  - Time fields accept `Date`, Unix milliseconds, or ISO-8601 strings
    on input; the SDK converts to ripple time internally and surfaces
    JS `Date`s on read.
- **Proposed fix for the remainder**: a thin `XrplClient` wrapper for
  raw queries (account_info, ledger_entry, ...) and an OfferCreate
  helper if/when the use case lands.

### 2.1.bis (note) Naming intentionally hides the "trustline" jargon

- The Wallet API speaks intent (`acceptToken`, `refuseToken`, `holdsToken`,
  `enableTransfers`, ...). The word "trustline" only appears in the internal
  `sdk/src/utils/trustline.ts` module, which is **not** re-exported from the
  SDK barrel. Only the data types (`TrustlineInfo`, `SetTrustlineResult`)
  are public.
- One source of truth: every Wallet method is a 3-5 line wrapper around an
  internal free function in `utils/trustline.ts`. The auto-trustline path
  inside `serverCharge` calls the same internal API. No business logic is
  duplicated between the two surfaces.

### 2.2 No abstraction for transaction submission (`submit`, `submitAndWait`, polling)

- **Status**: open
- **Scope**: any custom transaction the consumer wants to broadcast.
- **Why it leaks**: there is no SDK-level "submit this signed blob and wait
  for tesSUCCESS" helper. Today, the SDK has private inline implementations
  inside `Charge.ts` and `Channel.ts`.
- **Proposed fix**: extract a `submitAndWait({ blob | tx, wallet, network })`
  utility on the eventual `XrplClient` wrapper.

---

## 3. Currency / amount handling

### 3.1 `IssuedCurrency` / `MPToken` types are SDK-defined, but amount construction still happens via xrpl-shaped objects

- **Status**: open (cosmetic / DX)
- **Scope**: charge requests with non-XRP currencies.
- **Why it leaks**: helpers like `buildAmount` are internal. Consumers who
  want to handcraft an amount object end up building xrpl-shaped
  `{ currency, issuer, value }` themselves.
- **Proposed fix**: export `buildAmount`, `parseCurrency`, `serializeCurrency`
  with explicit SDK contracts -- or a fluent `Amount` builder.

---

## 4. Errors

### 4.1 `tec*` result codes are mapped to typed errors only inside the SDK

- **Status**: closed for the documented codes; open for any new code added by
  future XRPL amendments.
- **Scope**: error handling in consumer code.
- **Note**: `TEC_RESULT_MAP` is exported, so consumers can map arbitrary
  result codes themselves. Keep this list in sync as new amendments land.

---

## 5. Tests / runtime coverage

### 5.1 Unit tests do not exercise `Wallet.fromFaucet`

- **Status**: open
- **Scope**: integration coverage.
- **Why it matters**: a runtime regression like the `ECDSA` named-export issue
  was caught only when running a demo. `npx tsc --noEmit` and `vitest run`
  passed silently because nothing in `test/` actually loads `wallet.ts` at
  runtime through the same module-resolution path the demos use.
- **Proposed fix**: add a smoke test under `test/integration/` that calls
  `Wallet.fromFaucet({ network: 'devnet' })` and asserts that
  `wallet.address` looks valid. Gate it on a `RUN_FAUCET_TESTS=1` env var
  to keep CI cheap.

---

## How to update this file

When you close a gap, change `Status` to `closed` and add a one-line note
referencing the PR / commit. Do not delete entries -- the history is useful
when reviewing the abstraction surface.

When you find a new gap, append a section in the matching top-level group
(or create a new one) and follow the same five-field shape.
