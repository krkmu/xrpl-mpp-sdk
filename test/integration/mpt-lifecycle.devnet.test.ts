import { describe, expect, it } from 'vitest'
import { Wallet } from '../../sdk/src/utils/wallet.js'

/**
 * Real-devnet exercise of every MPT-related Wallet method that the unit
 * suite mocks: `createToken`, `listIssuedTokens`, `acceptToken(mpt)`,
 * `authorize(holder, mpt)`, `issue(mpt)`, `holdsToken(mpt)`,
 * `listAcceptedTokens` (mixed result), `freeze`/`unfreeze` MPT,
 * `lockToken`/`unlockToken`, `clawback` MPT, `refuseToken(mpt)`,
 * `destroyToken`. Plus the immutable-flag guards `MPT_LOCK_NOT_ALLOWED`
 * and `MPT_CLAWBACK_NOT_ALLOWED`.
 *
 * Two scenarios:
 * 1. **Permissioned issuance** (`requireAuthorization` + `allowLock` +
 *    `allowClawback`): walks the happy path of every admin operation in
 *    sequence, mirroring the `iou-admin.devnet.test.ts` story.
 * 2. **Vanilla issuance** (no admin flags): asserts that `freeze` and
 *    `clawback` reject upfront with the typed `MPT_LOCK_NOT_ALLOWED` /
 *    `MPT_CLAWBACK_NOT_ALLOWED` errors -- since the flags are immutable
 *    per protocol, this is the only correct way to surface the limitation.
 *
 * Each scenario runs as a single sequential `it()` so the same wallets go
 * through the full lifecycle without re-funding. Splitting would either
 * be slow (extra faucet hits) or rely on shared `beforeAll` state which
 * makes assertion failures hard to localise.
 *
 * Gated by the integration runner config (`vitest.integration.config.ts`)
 * and the `pnpm test:integration` script -- it does NOT run in the
 * default unit suite.
 */
describe('integration: MPT admin lifecycle on devnet', () => {
  const NETWORK = 'devnet' as const

  it('walks an issuer + holder through the full permissioned-MPT lifecycle', async () => {
    const [issuer, holder] = await Promise.all([
      Wallet.fromFaucet({ network: NETWORK }),
      Wallet.fromFaucet({ network: NETWORK }),
    ])

    // ---- 1. Mint a fully-flagged issuance ------------------------------
    const { mpt, hash: createHash } = await issuer.createToken({
      assetScale: 2,
      maximumAmount: '1000000',
      requireAuthorization: true,
      allowLock: true,
      allowClawback: true,
      allowTransfer: true,
      network: NETWORK,
    })
    expect(createHash).toMatch(/^[0-9A-F]{64}$/)
    expect(mpt.mpt_issuance_id).toMatch(/^[0-9A-F]{40,}$/)

    // ---- 2. listIssuedTokens surfaces the freshly created issuance -----
    const issuances = await issuer.listIssuedTokens({ network: NETWORK })
    const issued = issuances.find((i) => i.mpt_issuance_id === mpt.mpt_issuance_id)
    expect(issued).toBeDefined()
    expect(issued?.issuer).toBe(issuer.address)
    expect(issued?.flags.requireAuthorization).toBe(true)
    expect(issued?.flags.canLock).toBe(true)
    expect(issued?.flags.canClawback).toBe(true)
    expect(issued?.flags.canTransfer).toBe(true)
    expect(issued?.outstandingAmount).toBe('0')

    // ---- 3. Holder accepts -> pending_authorization (allowlist) --------
    const accept1 = await holder.acceptToken(mpt, { network: NETWORK })
    expect(accept1.status).toBe('pending_authorization')

    // ---- 4. holdsToken reports authorized=false in pending state -------
    const pendingHolding = await holder.holdsToken(mpt, { network: NETWORK })
    expect(pendingHolding).toBeDefined()
    expect(pendingHolding && 'mpt_issuance_id' in pendingHolding).toBe(true)
    if (pendingHolding && 'mpt_issuance_id' in pendingHolding) {
      expect(pendingHolding.authorized).toBe(false)
      expect(pendingHolding.balance).toBe('0')
    }

    // ---- 5. Issuer authorises the holder --------------------------------
    const auth = await issuer.authorize(holder.address, mpt, { network: NETWORK })
    expect(auth.hash).toMatch(/^[0-9A-F]{64}$/)

    // ---- 6. acceptToken is idempotent post-authorization ---------------
    const accept2 = await holder.acceptToken(mpt, { network: NETWORK })
    expect(accept2.status).toBe('unchanged')

    // ---- 7. holdsToken now reports authorized=true ---------------------
    const authorisedHolding = await holder.holdsToken(mpt, { network: NETWORK })
    if (authorisedHolding && 'mpt_issuance_id' in authorisedHolding) {
      expect(authorisedHolding.authorized).toBe(true)
    } else {
      throw new Error('Expected MPT holding after authorisation')
    }

    // ---- 8. Issuance via Payment ---------------------------------------
    const issuedTx = await issuer.issue(holder.address, '1000', mpt, { network: NETWORK })
    expect(issuedTx.hash).toMatch(/^[0-9A-F]{64}$/)

    // ---- 9. listAcceptedTokens picks up the MPT (mixed result) ---------
    const inventory = await holder.listAcceptedTokens({ network: NETWORK })
    const mptRow = inventory.find(
      (t) => t.kind === 'mpt' && t.mpt_issuance_id === mpt.mpt_issuance_id,
    )
    expect(mptRow).toBeDefined()
    expect(mptRow?.kind).toBe('mpt')
    if (mptRow?.kind === 'mpt') {
      expect(mptRow.balance).toBe('1000')
      expect(mptRow.authorized).toBe(true)
      expect(mptRow.locked).toBe(false)
    }

    // ---- 10. Per-holder freeze / unfreeze ------------------------------
    await issuer.freeze(holder.address, mpt, { network: NETWORK })
    const frozenSnap = await holder.holdsToken(mpt, { network: NETWORK })
    if (frozenSnap && 'mpt_issuance_id' in frozenSnap) {
      expect(frozenSnap.locked).toBe(true)
    }

    await issuer.unfreeze(holder.address, mpt, { network: NETWORK })
    const thawedSnap = await holder.holdsToken(mpt, { network: NETWORK })
    if (thawedSnap && 'mpt_issuance_id' in thawedSnap) {
      expect(thawedSnap.locked).toBe(false)
    }

    // ---- 11. Whole-issuance lock / unlock ------------------------------
    await issuer.lockToken(mpt, { network: NETWORK })
    const issuanceLocked = (await issuer.listIssuedTokens({ network: NETWORK })).find(
      (i) => i.mpt_issuance_id === mpt.mpt_issuance_id,
    )
    expect(issuanceLocked?.locked).toBe(true)

    await issuer.unlockToken(mpt, { network: NETWORK })
    const issuanceUnlocked = (await issuer.listIssuedTokens({ network: NETWORK })).find(
      (i) => i.mpt_issuance_id === mpt.mpt_issuance_id,
    )
    expect(issuanceUnlocked?.locked).toBe(false)

    // ---- 12. Clawback the full balance ---------------------------------
    const clawback = await issuer.clawback(holder.address, '1000', mpt, { network: NETWORK })
    expect(clawback.hash).toMatch(/^[0-9A-F]{64}$/)

    const afterClawback = await holder.holdsToken(mpt, { network: NETWORK })
    if (afterClawback && 'mpt_issuance_id' in afterClawback) {
      expect(afterClawback.balance).toBe('0')
    }

    // ---- 13. Holder refuses the now-empty MPT (deletes the entry) ------
    const refuse = await holder.refuseToken(mpt, { network: NETWORK })
    expect(refuse.status).toBe('removed')

    const afterRefuse = await holder.holdsToken(mpt, { network: NETWORK })
    expect(afterRefuse).toBeNull()

    // ---- 14. destroyToken now succeeds (no outstanding supply) ---------
    const destroyed = await issuer.destroyToken(mpt, { network: NETWORK })
    expect(destroyed.hash).toMatch(/^[0-9A-F]{64}$/)

    const afterDestroy = await issuer.listIssuedTokens({ network: NETWORK })
    expect(afterDestroy.find((i) => i.mpt_issuance_id === mpt.mpt_issuance_id)).toBeUndefined()
  }, 300_000)

  it('rejects freeze and clawback when the issuance lacks the immutable admin flags', async () => {
    const [issuer, holder] = await Promise.all([
      Wallet.fromFaucet({ network: NETWORK }),
      Wallet.fromFaucet({ network: NETWORK }),
    ])

    // Vanilla issuance: only allowTransfer (default), no allowLock, no
    // allowClawback, no requireAuthorization. Once minted, the issuer
    // can never freeze a holder or claw back -- those flags are immutable.
    const { mpt } = await issuer.createToken({
      assetScale: 2,
      maximumAmount: '1000',
      network: NETWORK,
    })

    const accept = await holder.acceptToken(mpt, { network: NETWORK })
    expect(accept.status).toBe('created')

    await issuer.issue(holder.address, '100', mpt, { network: NETWORK })

    // freeze should reject upfront with MPT_LOCK_NOT_ALLOWED -- never hit
    // the network because the flag is missing on the issuance.
    await expect(issuer.freeze(holder.address, mpt, { network: NETWORK })).rejects.toThrow(
      /MPT_LOCK_NOT_ALLOWED/,
    )

    // lockToken (whole-issuance) is gated by the same flag.
    await expect(issuer.lockToken(mpt, { network: NETWORK })).rejects.toThrow(
      /MPT_LOCK_NOT_ALLOWED/,
    )

    // clawback should reject upfront with MPT_CLAWBACK_NOT_ALLOWED.
    await expect(issuer.clawback(holder.address, '50', mpt, { network: NETWORK })).rejects.toThrow(
      /MPT_CLAWBACK_NOT_ALLOWED/,
    )

    // refuseToken with a non-zero balance is rejected by the SDK guard --
    // the holder must drain the balance before it can delete the MPToken
    // ledger entry.
    await expect(holder.refuseToken(mpt, { network: NETWORK })).rejects.toThrow(/MPT_HAS_BALANCE/)
  }, 240_000)
})
