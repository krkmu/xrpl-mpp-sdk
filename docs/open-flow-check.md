# Open-flow placeholder signature check -- 2026-05-01 follow-up

## Current behavior (code references)

**Client side** (`sdk/src/channel/client/Channel.ts:51-74`):
For `action: 'open'`, the client signs the initial claim against
`channelId || '0'.repeat(64)` -- in practice always the all-zero
placeholder, because the real `channelId` does not exist yet on the
ledger when the client signs. The signed amount is the challenge
`request.amount`.

**Server side** (`sdk/src/channel/server/Channel.ts:336-363`):
After broadcasting `PaymentChannelCreate` and extracting the real
`channelId` from metadata, the server runs `verifyPaymentChannelClaim`
against the real `channelId`. Because the client signed against the
placeholder, the signature does **not** verify. The server then takes
this branch:

```ts
if (sigValid) {
  await store.put(`xrpl:channel:${channelId}`, { cumulative: initialAmount, signature: payload.signature, ... })
} else {
  await store.put(`xrpl:channel:${channelId}`, { cumulative: '0', signature: '', ... })
}
```

The receipt is returned with `status: 'success'` regardless. **The
client's signed claim of `initialAmount` is silently discarded** and
replaced with `cumulative: 0`.

## Did the Phase 2 DID source binding close this?

**No.** The Phase 2 binding asserts that `credential.source` derives to
the same address as the configured `publicKey` (or the channel's
`Account`). That check passes for a legitimate funder using a
placeholder signature -- the source is right; only the signature is
wrong. The two checks are orthogonal.

## Status: gap is **still present**

What goes wrong in practice:
- A legitimate funder thinks they committed to deliver `initialAmount`
  drops as the first claim. The server has `cumulative: 0`. The
  invariant the funder reasoned about is silently broken.
- A client bug that produces a near-correct-but-wrong signature
  (off-by-one channelId, wrong wallet, wrong amount in the sig vs
  the payload) is hidden. The server zeroes the state and proceeds.
- The protocol cannot use the open action to atomically settle an
  initial obligation -- there is no way for a server to *enforce*
  that the open carries a real first claim.

This is not a credential-replay or hash-theft vector. It is a
silent-failure vector that hides bugs and breaks the funder's mental
model.

## Fix

**Explicit reject path** (chosen over simulate-and-re-sign for
simplicity and round-trip cost):

- If `initialAmount > 0` and the placeholder signature does not verify
  against the real `channelId`, throw `INVALID_SIGNATURE` with a
  message that names the placeholder vs real channelId and points the
  caller at sending an `initialAmount` of `'0'` if they don't want to
  commit during open.
- If `initialAmount === 0`, the client is explicitly opening without
  an initial commitment. Skip the signature check, store
  `cumulative: '0', signature: ''`. This case is unambiguous because
  the client has not claimed anything.
- If `initialAmount > 0` and the signature *does* verify (rare, would
  require the client to know the channelId in advance), store
  `cumulative: initialAmount` as today.

The fix is minimal: replace the silent-fallback `else` branch with a
typed throw, and add an `if (initialAmount === 0n)` early-out. Total
diff is roughly 15 lines plus a unit test.
