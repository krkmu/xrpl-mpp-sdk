import { Credential, Store } from 'mppx'
import { type Client, type Wallet, Client as XrplClient } from 'xrpl'
import { type NetworkId, XRPL_RPC_URLS } from '../../sdk/src/constants.js'

// -- Test Wallet Creation --

const NETWORK: NetworkId = 'testnet'

export async function createTestWallet(
  curve: 'ed25519' | 'secp256k1' = 'ed25519',
): Promise<{ wallet: Wallet; client: Client }> {
  const client = await createTestClient()
  const fund = await client.fundWallet(null, {
    algorithm: curve,
  })
  return { wallet: fund.wallet, client }
}

export async function createTestClient(): Promise<Client> {
  const client = new XrplClient(XRPL_RPC_URLS[NETWORK])
  await client.connect()
  return client
}

export function createTestStore(): ReturnType<typeof Store.memory> {
  return Store.memory()
}

// -- Mock Challenge Helpers --

export function createMockChargeChallenge(
  overrides: Partial<{
    amount: string
    currency: string
    recipient: string
    network: string
    description: string
    externalId: string
  }> = {},
): {
  id: string
  realm: string
  method: string
  intent: string
  request: {
    amount: string
    currency: string
    recipient: string
    methodDetails?: { network?: string; reference?: string }
  }
} {
  return {
    id: `test-challenge-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    realm: 'test.example.com',
    method: 'xrpl',
    intent: 'charge',
    request: {
      amount: overrides.amount ?? '1000000',
      currency: overrides.currency ?? 'XRP',
      recipient: overrides.recipient ?? 'rN7bRFgBrNZKoY2uu015bdjah11UbRZY',
      ...(overrides.description && { description: overrides.description }),
      ...(overrides.externalId && { externalId: overrides.externalId }),
      methodDetails: {
        network: overrides.network ?? 'testnet',
        reference: `ref-${Date.now()}`,
      },
    },
  }
}

export function createMockChannelChallenge(
  overrides: Partial<{
    amount: string
    channelId: string
    recipient: string
    network: string
    cumulativeAmount: string
  }> = {},
): {
  id: string
  realm: string
  method: string
  intent: string
  request: {
    amount: string
    channelId: string
    recipient: string
    methodDetails?: { network?: string; reference?: string; cumulativeAmount?: string }
  }
} {
  return {
    id: `test-channel-challenge-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    realm: 'test.example.com',
    method: 'xrpl',
    intent: 'channel',
    request: {
      amount: overrides.amount ?? '100000',
      channelId: overrides.channelId ?? '0'.repeat(64),
      recipient: overrides.recipient ?? 'rN7bRFgBrNZKoY2uu015bdjah11UbRZY',
      methodDetails: {
        network: overrides.network ?? 'testnet',
        reference: `ref-${Date.now()}`,
        cumulativeAmount: overrides.cumulativeAmount ?? '0',
      },
    },
  }
}

// -- Credential Helpers --

export function serializeCredential(challenge: Record<string, unknown>, payload: unknown): string {
  return Credential.serialize(
    Credential.from({
      challenge: challenge as any,
      payload,
    }),
  )
}

// -- Cleanup --

const activeClients: Client[] = []

export function trackClient(client: Client): Client {
  activeClients.push(client)
  return client
}

export async function disconnectAll(): Promise<void> {
  for (const client of activeClients) {
    try {
      if (client.isConnected()) {
        await client.disconnect()
      }
    } catch {
      // Ignore disconnect errors during cleanup
    }
  }
  activeClients.length = 0
}

// -- Network test guard --

export const SKIP_NETWORK = process.env.SKIP_NETWORK === 'true'

export function describeNetwork(name: string, fn: () => void): void {
  if (SKIP_NETWORK) {
    describe.skip(`[NETWORK] ${name}`, fn)
  } else {
    describe(`[NETWORK] ${name}`, fn)
  }
}
