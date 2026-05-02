import { Credential, Store } from 'mppx'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type Client, dropsToXrp, signPaymentChannelClaim, type Wallet } from 'xrpl'
import { openChannel } from '../../sdk/src/channel/client/Channel.js'
import { close, channel as serverChannel } from '../../sdk/src/channel/server/Channel.js'
import { connectDevnet, createFundedWallet, devnetSource } from './devnet-helpers.ts'

/**
 * Channel lifecycle on devnet:
 * 1. Funder opens a 5 XRP PaymentChannel to receiver.
 * 2. Funder issues 3 off-chain claims (100k -> 200k -> 300k drops).
 * 3. Server verify() accepts each claim, with on-chain verification enabled
 *    (default), so it actually does a ledger_entry RPC.
 * 4. Receiver closes the channel by submitting PaymentChannelClaim with the
 *    latest cumulative amount + signature.
 */
describe('integration: PayChannel lifecycle on devnet', () => {
  let client: Client
  let funder: Wallet
  let receiver: Wallet

  beforeAll(async () => {
    client = await connectDevnet()
    ;[funder, receiver] = await Promise.all([
      createFundedWallet(client),
      createFundedWallet(client),
    ])
  })

  afterAll(async () => {
    await client?.disconnect()
  })

  it('opens channel, accepts 3 vouchers, closes with cumulative on-chain', async () => {
    const { channelId, txHash: openTx } = await openChannel({
      seed: funder.seed!,
      destination: receiver.classicAddress,
      amount: '5000000',
      settleDelay: 60,
      network: 'devnet',
    })
    expect(openTx).toMatch(/^[0-9A-F]{64}$/)
    expect(channelId).toMatch(/^[0-9A-F]{64}$/)

    const store = Store.memory()
    const method = serverChannel({
      publicKey: funder.publicKey,
      network: 'devnet',
      store,
      verifyChannelOnChain: true,
    })

    let prev = '0'
    let lastSig = ''
    for (const cum of ['100000', '200000', '300000']) {
      const sig = signPaymentChannelClaim(channelId, dropsToXrp(cum).toString(), funder.privateKey)
      const challenge = {
        id: `int-ch-${cum}-${Date.now()}`,
        realm: 'integration-test',
        method: 'xrpl' as const,
        intent: 'channel' as const,
        createdAt: new Date().toISOString(),
        request: {
          amount: (BigInt(cum) - BigInt(prev)).toString(),
          channelId,
          recipient: receiver.classicAddress,
          methodDetails: { network: 'devnet' as const, cumulativeAmount: prev },
        },
      }
      const cred = Credential.from({
        challenge: challenge as any,
        payload: { action: 'voucher', channelId, amount: cum, signature: sig },
        source: devnetSource(funder),
      })
      const receipt = await method.verify({
        credential: cred as any,
        request: challenge.request,
      })
      expect(receipt.status).toBe('success')
      prev = cum
      lastSig = sig
    }

    // Receiver closes the channel by redeeming the latest cumulative claim.
    const { txHash: closeTx } = await close({
      seed: receiver.seed!,
      channelId,
      amount: prev,
      signature: lastSig,
      channelPublicKey: funder.publicKey,
      network: 'devnet',
      store,
    })
    expect(closeTx).toMatch(/^[0-9A-F]{64}$/)
  }, 360_000)
})
