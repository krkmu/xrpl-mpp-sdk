import { describe, expect, it } from 'vitest'
import { Wallet } from '../../sdk/src/utils/wallet.js'

/**
 * Real-devnet exercise of every Wallet method that the unit suite mocks:
 * `enableTransfers`, `requireAuthorization`, `allowClawback`, `acceptToken`
 * (in its `pending_authorization` shape), `authorize`, `issue`, `holdsToken`,
 * `listAcceptedTokens`, `freeze`, `unfreeze`, `clawback`, `refuseToken`.
 *
 * The whole flow runs as a single sequential `it()` so the same pair of
 * wallets goes through the full lifecycle pending_auth -> authorized ->
 * issued -> frozen -> thawed -> clawed back -> removed. Splitting it into
 * smaller tests would either re-fund wallets (slow) or rely on shared
 * `beforeAll` state, which makes assertion failures harder to localise.
 *
 * Gated by the integration runner config (`vitest.integration.config.ts`) and
 * the `pnpm test:integration` script -- it does NOT run in the default unit
 * suite.
 */
describe('integration: IOU admin lifecycle on devnet', () => {
  it('walks an issuer + holder through the full permissioned-IOU lifecycle', async () => {
    const [issuer, holder] = await Promise.all([
      Wallet.fromFaucet({ network: 'devnet' }),
      Wallet.fromFaucet({ network: 'devnet' }),
    ])

    const currency = { currency: 'ACM', issuer: issuer.address }
    const NETWORK = 'devnet' as const

    // ---- 1. Issuer admin flags (must precede any trustline) -------------
    const transfers = await issuer.enableTransfers({ network: NETWORK })
    expect(transfers.hash).toMatch(/^[0-9A-F]{64}$/)

    const requireAuth = await issuer.requireAuthorization(true, { network: NETWORK })
    expect(requireAuth.hash).toMatch(/^[0-9A-F]{64}$/)

    const allowCb = await issuer.allowClawback({ network: NETWORK })
    expect(allowCb.hash).toMatch(/^[0-9A-F]{64}$/)

    // ---- 2. Holder accepts -> pending_authorization ---------------------
    const accept1 = await holder.acceptToken(currency, { network: NETWORK, limit: '1000' })
    expect(accept1.status).toBe('pending_authorization')

    // ---- 3. Issuer authorises the holder trustline ----------------------
    const auth = await issuer.authorize(holder.address, currency, { network: NETWORK })
    expect(auth.hash).toMatch(/^[0-9A-F]{64}$/)

    // ---- 4. Re-running acceptToken is idempotent ------------------------
    const accept2 = await holder.acceptToken(currency, { network: NETWORK, limit: '1000' })
    expect(accept2.status).toBe('unchanged')

    // ---- 5. Issuance ----------------------------------------------------
    const issued = await issuer.issue(holder.address, '100', currency, { network: NETWORK })
    expect(issued.hash).toMatch(/^[0-9A-F]{64}$/)

    // ---- 6. Holder inventory --------------------------------------------
    const inventory = await holder.listAcceptedTokens({ network: NETWORK })
    const acmeRow = inventory.find((t) => t.currency === 'ACM' && t.issuer === issuer.address)
    expect(acmeRow?.balance).toBe('100')
    expect(acmeRow?.authorized).toBe(true)

    // ---- 7. Freeze / unfreeze, observed via holdsToken ------------------
    await issuer.freeze(holder.address, currency, { network: NETWORK })
    const frozenSnap = await holder.holdsToken(currency, { network: NETWORK })
    expect(frozenSnap?.frozen).toBe(true)

    await issuer.unfreeze(holder.address, currency, { network: NETWORK })
    const thawedSnap = await holder.holdsToken(currency, { network: NETWORK })
    expect(thawedSnap?.frozen).toBe(false)

    // ---- 8. Clawback the full balance -----------------------------------
    const clawback = await issuer.clawback(holder.address, '100', currency, {
      network: NETWORK,
    })
    expect(clawback.hash).toMatch(/^[0-9A-F]{64}$/)

    const afterClawback = await holder.holdsToken(currency, { network: NETWORK })
    expect(afterClawback?.balance).toBe('0')

    // ---- 9. Holder refuses the now-empty trustline ----------------------
    // Because the issuer has RequireAuth and has authorised this holder,
    // the auth flag remains on the line and XRPL refuses to delete the
    // ledger entry. The TrustSet still succeeds and zeroes the limit.
    const refuse = await holder.refuseToken(currency, { network: NETWORK })
    expect(refuse.status).toBe('cleared')

    const finalInventory = await holder.listAcceptedTokens({ network: NETWORK })
    const lingering = finalInventory.find(
      (t) => t.currency === 'ACM' && t.issuer === issuer.address,
    )
    expect(lingering).toBeDefined()
    expect(lingering?.balance).toBe('0')
    expect(lingering?.limit).toBe('0')
  }, 300_000)
})
