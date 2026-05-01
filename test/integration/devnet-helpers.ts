import { Client, type Wallet } from 'xrpl'

/**
 * XRPL devnet WebSocket. Devnet has more permissive faucet rate limits than
 * testnet and resets state more frequently, so it's the best place to run
 * end-to-end integration tests.
 */
export const DEVNET_WS = 'wss://s.devnet.rippletest.net:51233'

/**
 * Connect a fresh xrpl.js Client to devnet. Caller must `disconnect()`.
 */
export async function connectDevnet(): Promise<Client> {
  const client = new Client(DEVNET_WS)
  await client.connect()
  return client
}

/**
 * Generate and fund an ephemeral devnet wallet via the public faucet.
 * Returns the wallet (with seed) and the funded balance reported by the faucet.
 *
 * Throws if the faucet times out -- callers should pass a useful test message
 * via `vitest.it.skipIf` or surface the error so the suite is informative.
 */
export async function createFundedWallet(
  client: Client,
  algorithm: 'ed25519' | 'ecdsa-secp256k1' = 'ed25519',
): Promise<Wallet> {
  const out = await client.fundWallet(null, { algorithm })
  return out.wallet
}

/**
 * Build the `did:pkh:xrpl:devnet:{addr}` source string for a wallet.
 */
export function devnetSource(wallet: Wallet): string {
  return `did:pkh:xrpl:devnet:${wallet.classicAddress}`
}
