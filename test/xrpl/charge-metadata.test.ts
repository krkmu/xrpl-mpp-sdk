import { Credential, Store } from 'mppx'
import { describe, expect, it } from 'vitest'
import { Wallet } from 'xrpl'
import { charge as serverCharge } from '../../sdk/src/server/Charge.js'

const NETWORK = 'testnet'

function buildCharge(args: {
  payer: Wallet
  recipient: Wallet
  amount: string
  tx: any
  challengeMethodDetails?: Record<string, unknown>
}) {
  const { payer, recipient, amount, tx, challengeMethodDetails = {} } = args
  const signed = payer.sign(tx as any)
  const challenge = {
    id: `meta-${Math.random().toString(36).slice(2)}`,
    realm: 'test',
    method: 'xrpl' as const,
    intent: 'charge' as const,
    createdAt: new Date().toISOString(),
    request: {
      amount,
      currency: 'XRP',
      recipient: recipient.classicAddress,
      methodDetails: { network: NETWORK, ...challengeMethodDetails },
    },
  }
  const cred = Credential.from({
    challenge: challenge as any,
    payload: { type: 'transaction', blob: signed.tx_blob },
    source: `did:pkh:xrpl:${NETWORK}:${payer.classicAddress}`,
  })
  return { challenge, cred }
}

function basePayment(payer: Wallet, recipient: string, amount: string) {
  return {
    TransactionType: 'Payment' as const,
    Account: payer.classicAddress,
    Destination: recipient,
    Amount: amount,
    Fee: '12',
    Sequence: 1,
    SigningPubKey: payer.publicKey,
    Flags: 0,
    LastLedgerSequence: 100_000_000,
  }
}

describe('charge server -- DestinationTag / SourceTag / InvoiceID enforcement', () => {
  it('rejects pull-mode credential when DestinationTag in tx does not match challenge', async () => {
    const payer = Wallet.generate()
    const recipient = Wallet.generate()
    const tx = { ...basePayment(payer, recipient.classicAddress, '1000000'), DestinationTag: 999 }
    const { challenge, cred } = buildCharge({
      payer,
      recipient,
      amount: '1000000',
      tx,
      challengeMethodDetails: { destinationTag: 12345 },
    })
    const method = serverCharge({
      recipient: recipient.classicAddress,
      store: Store.memory(),
      network: NETWORK,
    })
    await expect(
      method.verify({ credential: cred as any, request: challenge.request }),
    ).rejects.toThrow(/DestinationTag mismatch/)
  })

  it('rejects pull-mode credential when SourceTag in tx does not match challenge', async () => {
    const payer = Wallet.generate()
    const recipient = Wallet.generate()
    const tx = { ...basePayment(payer, recipient.classicAddress, '1000000'), SourceTag: 7 }
    const { challenge, cred } = buildCharge({
      payer,
      recipient,
      amount: '1000000',
      tx,
      challengeMethodDetails: { sourceTag: 8 },
    })
    const method = serverCharge({
      recipient: recipient.classicAddress,
      store: Store.memory(),
      network: NETWORK,
    })
    await expect(
      method.verify({ credential: cred as any, request: challenge.request }),
    ).rejects.toThrow(/SourceTag mismatch/)
  })

  it('rejects pull-mode credential when challenge expects a tag but tx has none', async () => {
    const payer = Wallet.generate()
    const recipient = Wallet.generate()
    const tx = basePayment(payer, recipient.classicAddress, '1000000')
    const { challenge, cred } = buildCharge({
      payer,
      recipient,
      amount: '1000000',
      tx,
      challengeMethodDetails: { destinationTag: 12345 },
    })
    const method = serverCharge({
      recipient: recipient.classicAddress,
      store: Store.memory(),
      network: NETWORK,
    })
    await expect(
      method.verify({ credential: cred as any, request: challenge.request }),
    ).rejects.toThrow(/DestinationTag mismatch.*got none/)
  })
})
