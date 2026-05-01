import { Credential } from 'mppx'
import { describe, expect, it, vi } from 'vitest'
import type xrplLib from 'xrpl'

// Mock xrpl Client used inside the client charge flow. We override the module
// at vi.mock() time so the charge factory loads the mocked Client when it
// imports xrpl.
//
// The mocked Client supports connect(), disconnect(), autofill() (no-op),
// submitAndWait() (returns a fake hash), submit(), and request() (returns
// stubbed account_info / server_state).
const fakeHash = 'C'.repeat(64)

vi.mock('xrpl', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof xrplLib
  class FakeClient {
    constructor(public readonly url: string) {}
    async connect() {}
    async disconnect() {}
    async autofill(tx: any) {
      return { ...tx, Sequence: 1, Fee: '12', LastLedgerSequence: 100_000_000 }
    }
    async submit(_blob: string) {
      return { result: { engine_result: 'tesSUCCESS', tx_json: { hash: fakeHash } } }
    }
    async submitAndWait(_tx: any, _opts: any) {
      return { result: { meta: { TransactionResult: 'tesSUCCESS' }, hash: fakeHash } }
    }
    async request(params: any) {
      if (params.command === 'account_info') {
        return {
          result: { account_data: { Balance: '50000000', OwnerCount: 0, Flags: 0x00800000 } },
        }
      }
      if (params.command === 'server_state') {
        return {
          result: {
            state: { validated_ledger: { reserve_base: '1000000', reserve_inc: '200000' } },
          },
        }
      }
      return { result: {} }
    }
  }
  return {
    ...actual,
    Client: FakeClient,
  }
})

const { charge } = await import('../../sdk/src/client/Charge.js')
const { Wallet, decode } = await import('xrpl')

describe('charge client createCredential() -- pull mode happy path', () => {
  it('produces a credential whose blob decodes to the expected Payment fields', async () => {
    const payer = Wallet.generate()
    const recipient = Wallet.generate()

    const method = charge({
      seed: payer.seed!,
      mode: 'pull',
      preflight: true,
      network: 'devnet',
    })

    const challenge = {
      id: 'mock-1',
      realm: 'test',
      method: 'xrpl' as const,
      intent: 'charge' as const,
      createdAt: new Date().toISOString(),
      request: {
        amount: '500000',
        currency: 'XRP',
        recipient: recipient.classicAddress,
        methodDetails: { network: 'devnet' as const, destinationTag: 42 },
      },
    }

    const blob = await method.createCredential({ challenge: challenge as any } as any)
    const cred = Credential.deserialize(blob)
    expect(cred.source).toBe(`did:pkh:xrpl:devnet:${payer.classicAddress}`)
    const payload = cred.payload as { type: 'transaction'; blob: string }
    expect(payload.type).toBe('transaction')
    const decoded = decode(payload.blob) as any
    expect(decoded.TransactionType).toBe('Payment')
    expect(decoded.Account).toBe(payer.classicAddress)
    expect(decoded.Destination).toBe(recipient.classicAddress)
    expect(decoded.Amount).toBe('500000')
    expect(decoded.DestinationTag).toBe(42)
  })

  it('returns push-mode credential when mode override = push', async () => {
    const payer = Wallet.generate()
    const recipient = Wallet.generate()

    const method = charge({
      seed: payer.seed!,
      mode: 'pull',
      preflight: false,
      network: 'devnet',
    })

    const challenge = {
      id: 'mock-2',
      realm: 'test',
      method: 'xrpl' as const,
      intent: 'charge' as const,
      createdAt: new Date().toISOString(),
      request: {
        amount: '100000',
        currency: 'XRP',
        recipient: recipient.classicAddress,
        methodDetails: { network: 'devnet' as const },
      },
    }

    const blob = await method.createCredential({
      challenge: challenge as any,
      context: { mode: 'push' },
    } as any)
    const cred = Credential.deserialize(blob)
    const payload = cred.payload as { type: 'hash'; hash: string }
    expect(payload.type).toBe('hash')
    // Hash is computed from the signed blob by xrpl.js, not the mock submit response.
    expect(payload.hash).toMatch(/^[0-9A-F]{64}$/)
  })

  it('throws when seed is missing', async () => {
    expect(() => charge({} as any)).toThrow(/seed is required/)
  })
})
