import { Client } from 'xrpl'
import { Wallet } from '../../sdk/src/utils/wallet.js'

/**
 * XRPL devnet WebSocket. Devnet has more permissive faucet rate limits than
 * testnet and resets state more frequently, so it's the best place to run
 * end-to-end integration tests.
 */
export const DEVNET_WS = 'wss://s.devnet.rippletest.net:51233'

/**
 * Connect a fresh xrpl.js Client to devnet. Caller must `disconnect()`.
 *
 * Kept around for the few integration scenarios that need a long-lived
 * client (e.g. probing `feature` for amendment activation, or running an
 * orderbook setup that the SDK does not yet abstract).
 */
export async function connectDevnet(): Promise<Client> {
  const client = new Client(DEVNET_WS)
  await client.connect()
  return client
}

/**
 * Generate and fund an ephemeral devnet wallet via the public faucet.
 * Returns the SDK {@link Wallet} so downstream tests can call the
 * SDK's high-level methods (`enableTransfers`, `acceptToken`, `issue`,
 * `signChannelClaim`, ...) directly without re-deriving from a seed.
 *
 * Throws if the faucet times out -- callers should surface the error so
 * the suite is informative rather than silently skipping.
 */
export async function createFundedWallet(): Promise<Wallet> {
  return Wallet.fromFaucet({ network: 'devnet' })
}

/**
 * Build the `did:pkh:xrpl:devnet:{addr}` source string for a wallet.
 * Accepts either an SDK {@link Wallet} or anything that exposes a
 * `classicAddress` (i.e. an `xrpl.Wallet`) so legacy call sites keep
 * compiling while they migrate.
 */
export function devnetSource(wallet: Wallet | { classicAddress: string }): string {
  const address = 'address' in wallet ? wallet.address : wallet.classicAddress
  return `did:pkh:xrpl:devnet:${address}`
}
