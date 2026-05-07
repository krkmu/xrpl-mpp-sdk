/**
 * Env-based wallet + config loading.
 *
 * ===========================================================================
 *  PRODUCTION WARNING
 * ===========================================================================
 *  Reading raw seeds out of `.env` is fine for LOCAL TESTNET DEVELOPMENT.
 *  It is NOT how a production service should hold keys.
 *
 *  Before deploying anywhere that touches mainnet:
 *    - Replace `loadWallets()` with a KMS / HSM / Vault-backed signer.
 *    - Inject SIGNING CAPABILITY into the process, never the seed itself.
 *    - Sweep recipient balances to cold storage on a schedule.
 *    - Add authn/authz at the application layer; payment is not auth.
 * ===========================================================================
 */
import 'dotenv/config'
import type { NetworkId } from 'xrpl-mpp-sdk'
import { Wallet } from 'xrpl-mpp-sdk'

const VALID_NETWORKS: readonly NetworkId[] = ['testnet', 'devnet', 'mainnet'] as const

export type Config = {
  network: NetworkId
  port: number
  serverUrl: string
  pricePer1kTokensDrops: bigint
  mppSecretKey: string
}

export function loadConfig(): Config {
  const network = (process.env.XRPL_NETWORK ?? 'testnet') as NetworkId
  if (!VALID_NETWORKS.includes(network)) {
    throw new Error(`XRPL_NETWORK must be one of ${VALID_NETWORKS.join(', ')}, got "${network}".`)
  }

  const port = Number(process.env.PORT ?? 3000)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`PORT must be a valid TCP port, got "${process.env.PORT}".`)
  }

  const serverUrl = process.env.SERVER_URL ?? `http://localhost:${port}`

  const priceRaw = process.env.AGENT_PRICE_DROPS_PER_1K_TOKENS ?? '100000'
  let pricePer1kTokensDrops: bigint
  try {
    pricePer1kTokensDrops = BigInt(priceRaw)
  } catch {
    throw new Error(`AGENT_PRICE_DROPS_PER_1K_TOKENS must be an integer, got "${priceRaw}".`)
  }
  if (pricePer1kTokensDrops <= 0n) {
    throw new Error('AGENT_PRICE_DROPS_PER_1K_TOKENS must be > 0.')
  }

  const mppSecretKey = process.env.MPP_SECRET_KEY ?? 'agent-template-dev-secret'
  if (network === 'mainnet' && mppSecretKey === 'agent-template-dev-secret') {
    throw new Error(
      'Refusing to start on mainnet with the default MPP_SECRET_KEY. Set a strong, ' +
        'unique MPP_SECRET_KEY env var.',
    )
  }

  return { network, port, serverUrl, pricePer1kTokensDrops, mppSecretKey }
}

/**
 * Load both wallets, generating ephemeral testnet wallets via the faucet
 * for any seed that's missing.
 *
 * `which` selects which sides we actually need:
 *   - 'recipient' for the server process
 *   - 'payer'     for the client process
 *   - 'both'      for the run-demo orchestrator
 */
export async function loadWallets(
  which: 'recipient' | 'payer' | 'both',
  network: NetworkId,
): Promise<{ recipient?: Wallet; payer?: Wallet }> {
  const recipientSeed = process.env.RECIPIENT_SEED
  const payerSeed = process.env.PAYER_SEED

  const wantsRecipient = which === 'recipient' || which === 'both'
  const wantsPayer = which === 'payer' || which === 'both'

  const recipient = wantsRecipient
    ? await loadOrFundWallet('RECIPIENT_SEED', recipientSeed, network)
    : undefined
  const payer = wantsPayer ? await loadOrFundWallet('PAYER_SEED', payerSeed, network) : undefined

  return { recipient, payer }
}

async function loadOrFundWallet(
  envName: string,
  seed: string | undefined,
  network: NetworkId,
): Promise<Wallet> {
  if (seed) {
    return Wallet.fromSeed(seed)
  }
  if (network === 'mainnet') {
    throw new Error(
      `${envName} is required on mainnet. Refusing to auto-fund a mainnet wallet ` +
        `(no faucet, would not be funded anyway).`,
    )
  }
  return Wallet.fromFaucet({ network })
}
