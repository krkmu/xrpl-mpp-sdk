/**
 * Error Showcase -- fail-fix-validate for every SDK error path
 *
 * Generates all wallets via testnet faucet. Each case:
 *   attempt (expect failure) -> display error -> fix -> retry (expect success) -> print tx
 *
 * Run: npx tsx demo/error-showcase.ts
 */
import { Credential, Store } from 'mppx'
import { Client, dropsToXrp, signPaymentChannelClaim, Wallet } from 'xrpl'
import { openChannel } from '../sdk/src/channel/client/Channel.js'
import { channel as serverChannel } from '../sdk/src/channel/server/Channel.js'
import { charge as clientCharge } from '../sdk/src/client/Charge.js'
import { XRPL_RPC_URLS } from '../sdk/src/constants.js'
import { charge as serverCharge } from '../sdk/src/server/Charge.js'
import * as log from './log.js'

const NETWORK = 'testnet'
const RPC = XRPL_RPC_URLS[NETWORK]

let caseNum = 0
const total = 12

function header(name: string) {
  caseNum++
  log.separator()
  log.box([`[${caseNum}/${total}] ${name}`])
}

async function runChargeFlow(params: {
  clientSeed: string
  recipient: string
  amount: string
  currency: string
  serverCurrency?: any
}): Promise<{ hash: string }> {
  const { clientSeed, recipient, amount, currency, serverCurrency } = params
  const store = Store.memory()
  const srv = serverCharge({ recipient, currency: serverCurrency, network: NETWORK, store })
  const cli = clientCharge({ seed: clientSeed, mode: 'pull', network: NETWORK })

  const challenge = {
    id: `err-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    realm: 'error-showcase',
    method: 'xrpl' as const,
    intent: 'charge' as const,
    request: {
      amount,
      currency,
      recipient,
      methodDetails: { network: NETWORK, reference: crypto.randomUUID() },
    },
  }

  const credentialStr = await cli.createCredential({ challenge })
  const credential = Credential.deserialize(credentialStr)
  const receipt = await srv.verify({ credential: credential as any, request: challenge.request })
  return { hash: receipt.reference }
}

async function main() {
  log.box(['XRPL MPP -- Error Showcase'])
  log.separator()
  log.loading('Generating wallets on XRPL testnet...')

  const xrpl = new Client(RPC)
  await xrpl.connect()

  const { wallet: mainWallet } = await xrpl.fundWallet()
  const { wallet: recipientWallet } = await xrpl.fundWallet()
  const { wallet: issuerWallet } = await xrpl.fundWallet()
  const { wallet: channelFunder } = await xrpl.fundWallet()
  const { wallet: channelReceiver } = await xrpl.fundWallet()
  const wrongSigner = Wallet.generate()

  log.wallet('Main', mainWallet.classicAddress)
  log.wallet('Recipient', recipientWallet.classicAddress)
  log.wallet('Issuer', issuerWallet.classicAddress)
  log.wallet('Channel funder', channelFunder.classicAddress)
  log.wallet('Channel receiver', channelReceiver.classicAddress)

  // ---- CASE 1 ----
  header('INSUFFICIENT_BALANCE')
  {
    log.loading('Attempting payment with unfunded wallet...')
    const unfunded = Wallet.generate()
    try {
      await runChargeFlow({
        clientSeed: unfunded.seed!,
        recipient: recipientWallet.classicAddress,
        amount: '1000000',
        currency: 'XRP',
      })
      log.error('Expected error but succeeded')
    } catch (err: any) {
      log.error(err.message.slice(0, 120))
    }

    log.fix('Funding wallet via testnet faucet...')
    await xrpl.fundWallet(unfunded)

    log.loading('Retrying...')
    try {
      const { hash } = await runChargeFlow({
        clientSeed: unfunded.seed!,
        recipient: recipientWallet.classicAddress,
        amount: '1000000',
        currency: 'XRP',
      })
      log.success('Payment succeeded')
      log.tx(hash, log.explorerLink(hash))
    } catch (err: any) {
      log.error(`Retry failed: ${err.message}`)
    }
  }

  // ---- CASE 2 ----
  header('RECIPIENT_NOT_FOUND')
  {
    const nonExistent = Wallet.generate()
    log.loading(`Paying to non-existent address ${nonExistent.classicAddress}...`)
    try {
      await runChargeFlow({
        clientSeed: mainWallet.seed!,
        recipient: nonExistent.classicAddress,
        amount: '1000000',
        currency: 'XRP',
      })
      log.error('Expected error but succeeded (1 XRP >= reserve, account auto-created)')
    } catch (err: any) {
      log.error(err.message.slice(0, 120))
    }

    log.fix('Funding destination account...')
    await xrpl.fundWallet(nonExistent)

    log.loading('Retrying...')
    try {
      const { hash } = await runChargeFlow({
        clientSeed: mainWallet.seed!,
        recipient: nonExistent.classicAddress,
        amount: '1000000',
        currency: 'XRP',
      })
      log.success('Payment succeeded')
      log.tx(hash, log.explorerLink(hash))
    } catch (err: any) {
      log.error(`Retry failed: ${err.message}`)
    }
  }

  // ---- CASE 3 ----
  header('AMOUNT_MISMATCH')
  {
    log.loading('Client signs 1 drop, server expects 1,000,000 drops...')
    const store = Store.memory()
    const srv = serverCharge({ recipient: recipientWallet.classicAddress, network: NETWORK, store })
    const cli = clientCharge({ seed: mainWallet.seed!, mode: 'pull', network: NETWORK })

    const wrongChallenge = {
      id: `err-amt-${Date.now()}`,
      realm: 'error-showcase',
      method: 'xrpl' as const,
      intent: 'charge' as const,
      request: {
        amount: '1',
        currency: 'XRP',
        recipient: recipientWallet.classicAddress,
        methodDetails: { network: NETWORK, reference: crypto.randomUUID() },
      },
    }
    const credStr = await cli.createCredential({ challenge: wrongChallenge })
    const cred = Credential.deserialize(credStr)

    try {
      await srv.verify({
        credential: cred as any,
        request: { ...wrongChallenge.request, amount: '1000000' },
      })
      log.error('Expected error but succeeded')
    } catch (err: any) {
      log.error(err.message.slice(0, 120))
    }

    log.fix('Client signs correct amount...')
    log.loading('Retrying...')
    try {
      const { hash } = await runChargeFlow({
        clientSeed: mainWallet.seed!,
        recipient: recipientWallet.classicAddress,
        amount: '1000000',
        currency: 'XRP',
      })
      log.success('Payment succeeded')
      log.tx(hash, log.explorerLink(hash))
    } catch (err: any) {
      log.error(`Retry failed: ${err.message}`)
    }
  }

  // ---- CASE 4 ----
  header('MISSING_TRUSTLINE')
  {
    log.loading('Setting up issuer with DefaultRipple...')
    await xrpl.submitAndWait(
      { TransactionType: 'AccountSet', Account: issuerWallet.classicAddress, SetFlag: 8 },
      { wallet: issuerWallet },
    )
    await xrpl.submitAndWait(
      {
        TransactionType: 'TrustSet',
        Account: recipientWallet.classicAddress,
        LimitAmount: { currency: 'USD', issuer: issuerWallet.classicAddress, value: '1000000' },
      },
      { wallet: recipientWallet },
    )

    const { wallet: noTrustClient } = await xrpl.fundWallet()
    log.loading('Attempting IOU payment without client trustline...')
    const currencyJson = JSON.stringify({ currency: 'USD', issuer: issuerWallet.classicAddress })
    try {
      await runChargeFlow({
        clientSeed: noTrustClient.seed!,
        recipient: recipientWallet.classicAddress,
        amount: '10',
        currency: currencyJson,
        serverCurrency: { currency: 'USD', issuer: issuerWallet.classicAddress },
      })
      log.error('Expected error but succeeded')
    } catch (err: any) {
      log.error(err.message.slice(0, 120))
    }

    log.fix('Creating trustline + issuing tokens...')
    await xrpl.submitAndWait(
      {
        TransactionType: 'TrustSet',
        Account: noTrustClient.classicAddress,
        LimitAmount: { currency: 'USD', issuer: issuerWallet.classicAddress, value: '1000000' },
      },
      { wallet: noTrustClient },
    )
    await xrpl.submitAndWait(
      {
        TransactionType: 'Payment',
        Account: issuerWallet.classicAddress,
        Destination: noTrustClient.classicAddress,
        Amount: { currency: 'USD', issuer: issuerWallet.classicAddress, value: '1000' },
      },
      { wallet: issuerWallet },
    )

    log.loading('Retrying...')
    try {
      const { hash } = await runChargeFlow({
        clientSeed: noTrustClient.seed!,
        recipient: recipientWallet.classicAddress,
        amount: '10',
        currency: currencyJson,
        serverCurrency: { currency: 'USD', issuer: issuerWallet.classicAddress },
      })
      log.success('Payment succeeded')
      log.tx(hash, log.explorerLink(hash))
    } catch (err: any) {
      log.error(`Retry failed: ${err.message}`)
    }
  }

  // ---- CASE 5 ----
  header('PAYMENT_PATH_FAILED')
  {
    const { wallet: badIssuer } = await xrpl.fundWallet()
    const { wallet: pathClient } = await xrpl.fundWallet()
    const { wallet: pathRecipient } = await xrpl.fundWallet()

    log.loading('Setting up IOU with rippling DISABLED...')
    await xrpl.submitAndWait(
      {
        TransactionType: 'TrustSet',
        Account: pathClient.classicAddress,
        LimitAmount: { currency: 'TST', issuer: badIssuer.classicAddress, value: '1000000' },
      },
      { wallet: pathClient },
    )
    await xrpl.submitAndWait(
      {
        TransactionType: 'TrustSet',
        Account: pathRecipient.classicAddress,
        LimitAmount: { currency: 'TST', issuer: badIssuer.classicAddress, value: '1000000' },
      },
      { wallet: pathRecipient },
    )
    await xrpl.submitAndWait(
      {
        TransactionType: 'Payment',
        Account: badIssuer.classicAddress,
        Destination: pathClient.classicAddress,
        Amount: { currency: 'TST', issuer: badIssuer.classicAddress, value: '1000' },
      },
      { wallet: badIssuer },
    )

    log.loading('Attempting IOU payment (rippling disabled)...')
    const currencyJson = JSON.stringify({ currency: 'TST', issuer: badIssuer.classicAddress })
    try {
      await runChargeFlow({
        clientSeed: pathClient.seed!,
        recipient: pathRecipient.classicAddress,
        amount: '10',
        currency: currencyJson,
        serverCurrency: { currency: 'TST', issuer: badIssuer.classicAddress },
      })
      log.error('Expected error but succeeded')
    } catch (err: any) {
      log.error(err.message.slice(0, 120))
    }

    log.fix('Enabling DefaultRipple on issuer...')
    await xrpl.submitAndWait(
      { TransactionType: 'AccountSet', Account: badIssuer.classicAddress, SetFlag: 8 },
      { wallet: badIssuer },
    )

    log.loading('Retrying...')
    try {
      const { hash } = await runChargeFlow({
        clientSeed: pathClient.seed!,
        recipient: pathRecipient.classicAddress,
        amount: '10',
        currency: currencyJson,
        serverCurrency: { currency: 'TST', issuer: badIssuer.classicAddress },
      })
      log.success('Payment succeeded')
      log.tx(hash, log.explorerLink(hash))
    } catch (err: any) {
      log.error(`Retry failed: ${err.message.slice(0, 120)}`)
    }
  }

  // ---- CASE 6 ----
  header('INSUFFICIENT_IOU_BALANCE')
  {
    const { wallet: emptyClient } = await xrpl.fundWallet()
    await xrpl.submitAndWait(
      {
        TransactionType: 'TrustSet',
        Account: emptyClient.classicAddress,
        LimitAmount: { currency: 'USD', issuer: issuerWallet.classicAddress, value: '1000000' },
      },
      { wallet: emptyClient },
    )

    log.loading('Client has trustline but zero token balance...')
    const currencyJson = JSON.stringify({ currency: 'USD', issuer: issuerWallet.classicAddress })
    try {
      await runChargeFlow({
        clientSeed: emptyClient.seed!,
        recipient: recipientWallet.classicAddress,
        amount: '10',
        currency: currencyJson,
        serverCurrency: { currency: 'USD', issuer: issuerWallet.classicAddress },
      })
      log.error('Expected error but succeeded')
    } catch (err: any) {
      log.error(err.message.slice(0, 120))
    }

    log.fix('Issuer sends tokens to client...')
    await xrpl.submitAndWait(
      {
        TransactionType: 'Payment',
        Account: issuerWallet.classicAddress,
        Destination: emptyClient.classicAddress,
        Amount: { currency: 'USD', issuer: issuerWallet.classicAddress, value: '1000' },
      },
      { wallet: issuerWallet },
    )

    log.loading('Retrying...')
    try {
      const { hash } = await runChargeFlow({
        clientSeed: emptyClient.seed!,
        recipient: recipientWallet.classicAddress,
        amount: '10',
        currency: currencyJson,
        serverCurrency: { currency: 'USD', issuer: issuerWallet.classicAddress },
      })
      log.success('Payment succeeded')
      log.tx(hash, log.explorerLink(hash))
    } catch (err: any) {
      log.error(`Retry failed: ${err.message}`)
    }
  }

  // ---- CASE 7 ----
  header('MPT_NOT_AUTHORIZED')
  {
    log.loading('Creating MPT issuance...')
    const { wallet: mptIssuer } = await xrpl.fundWallet()
    const { wallet: mptRecipient } = await xrpl.fundWallet()
    const { wallet: mptClient } = await xrpl.fundWallet()

    await xrpl.submitAndWait(
      {
        TransactionType: 'MPTokenIssuanceCreate' as any,
        Account: mptIssuer.classicAddress,
        AssetScale: 2,
        MaximumAmount: '100000000',
        Flags: 0x00000020,
      },
      { wallet: mptIssuer },
    )
    const objs = await xrpl.request({
      command: 'account_objects',
      account: mptIssuer.classicAddress,
      type: 'mpt_issuance',
    } as any)
    const mptId = (objs.result as any).account_objects[0].mpt_issuance_id

    await xrpl.submitAndWait(
      {
        TransactionType: 'MPTokenAuthorize' as any,
        Account: mptRecipient.classicAddress,
        MPTokenIssuanceID: mptId,
      },
      { wallet: mptRecipient },
    )

    log.loading('Attempting MPT payment without client authorization...')
    const currencyJson = JSON.stringify({ mpt_issuance_id: mptId })
    try {
      await runChargeFlow({
        clientSeed: mptClient.seed!,
        recipient: mptRecipient.classicAddress,
        amount: '100',
        currency: currencyJson,
        serverCurrency: { mpt_issuance_id: mptId },
      })
      log.error('Expected error but succeeded')
    } catch (err: any) {
      log.error(err.message.slice(0, 120))
    }

    log.fix('Authorizing client + issuing tokens...')
    await xrpl.submitAndWait(
      {
        TransactionType: 'MPTokenAuthorize' as any,
        Account: mptClient.classicAddress,
        MPTokenIssuanceID: mptId,
      },
      { wallet: mptClient },
    )
    await xrpl.submitAndWait(
      {
        TransactionType: 'Payment',
        Account: mptIssuer.classicAddress,
        Destination: mptClient.classicAddress,
        Amount: { mpt_issuance_id: mptId, value: '10000' } as any,
      },
      { wallet: mptIssuer },
    )

    log.loading('Retrying...')
    try {
      const { hash } = await runChargeFlow({
        clientSeed: mptClient.seed!,
        recipient: mptRecipient.classicAddress,
        amount: '100',
        currency: currencyJson,
        serverCurrency: { mpt_issuance_id: mptId },
      })
      log.success('Payment succeeded')
      log.tx(hash, log.explorerLink(hash))
    } catch (err: any) {
      log.error(`Retry failed: ${err.message}`)
    }
  }

  // ---- CASE 8 ----
  header('INSUFFICIENT_MPT_BALANCE')
  {
    const { wallet: mptIssuer2 } = await xrpl.fundWallet()
    const { wallet: mptRecip2 } = await xrpl.fundWallet()
    const { wallet: mptEmpty } = await xrpl.fundWallet()

    await xrpl.submitAndWait(
      {
        TransactionType: 'MPTokenIssuanceCreate' as any,
        Account: mptIssuer2.classicAddress,
        AssetScale: 2,
        MaximumAmount: '100000000',
        Flags: 0x00000020,
      },
      { wallet: mptIssuer2 },
    )
    const objs2 = await xrpl.request({
      command: 'account_objects',
      account: mptIssuer2.classicAddress,
      type: 'mpt_issuance',
    } as any)
    const mptId2 = (objs2.result as any).account_objects[0].mpt_issuance_id

    await xrpl.submitAndWait(
      {
        TransactionType: 'MPTokenAuthorize' as any,
        Account: mptRecip2.classicAddress,
        MPTokenIssuanceID: mptId2,
      },
      { wallet: mptRecip2 },
    )
    await xrpl.submitAndWait(
      {
        TransactionType: 'MPTokenAuthorize' as any,
        Account: mptEmpty.classicAddress,
        MPTokenIssuanceID: mptId2,
      },
      { wallet: mptEmpty },
    )

    log.loading('Client authorized but has zero MPT balance...')
    const currencyJson = JSON.stringify({ mpt_issuance_id: mptId2 })
    try {
      await runChargeFlow({
        clientSeed: mptEmpty.seed!,
        recipient: mptRecip2.classicAddress,
        amount: '100',
        currency: currencyJson,
        serverCurrency: { mpt_issuance_id: mptId2 },
      })
      log.error('Expected error but succeeded')
    } catch (err: any) {
      log.error(err.message.slice(0, 120))
    }

    log.fix('Issuer mints tokens to client...')
    await xrpl.submitAndWait(
      {
        TransactionType: 'Payment',
        Account: mptIssuer2.classicAddress,
        Destination: mptEmpty.classicAddress,
        Amount: { mpt_issuance_id: mptId2, value: '10000' } as any,
      },
      { wallet: mptIssuer2 },
    )

    log.loading('Retrying...')
    try {
      const { hash } = await runChargeFlow({
        clientSeed: mptEmpty.seed!,
        recipient: mptRecip2.classicAddress,
        amount: '100',
        currency: currencyJson,
        serverCurrency: { mpt_issuance_id: mptId2 },
      })
      log.success('Payment succeeded')
      log.tx(hash, log.explorerLink(hash))
    } catch (err: any) {
      log.error(`Retry failed: ${err.message}`)
    }
  }

  // ---- CASE 9 ----
  header('WRONG_SIGNER (channel)')
  {
    log.loading('Opening PayChannel...')
    const { channelId, txHash: createHash } = await openChannel({
      seed: channelFunder.seed!,
      destination: channelReceiver.classicAddress,
      amount: '5000000',
      settleDelay: 60,
      network: NETWORK,
    })
    log.tx(createHash, log.explorerLink(createHash))

    const store = Store.memory()
    const srvMethod = serverChannel({ publicKey: channelFunder.publicKey, network: NETWORK, store })

    log.loading('Signing claim with WRONG wallet...')
    const wrongSig = signPaymentChannelClaim(
      channelId,
      dropsToXrp('100000').toString(),
      wrongSigner.privateKey,
    )
    const ch = {
      id: `err-chan-${Date.now()}`,
      realm: 'error-showcase',
      method: 'xrpl' as const,
      intent: 'channel' as const,
      request: {
        amount: '100000',
        channelId,
        recipient: channelReceiver.classicAddress,
        methodDetails: { network: NETWORK, reference: crypto.randomUUID(), cumulativeAmount: '0' },
      },
    }
    const wrongCred = Credential.from({
      challenge: ch as any,
      payload: { action: 'voucher', channelId, amount: '100000', signature: wrongSig },
    })

    try {
      await srvMethod.verify({ credential: wrongCred as any, request: ch.request })
      log.error('Expected error but succeeded')
    } catch (err: any) {
      log.error(err.message.slice(0, 120))
    }

    log.fix('Signing with correct wallet...')
    const correctSig = signPaymentChannelClaim(
      channelId,
      dropsToXrp('100000').toString(),
      channelFunder.privateKey,
    )
    const correctCred = Credential.from({
      challenge: { ...ch, id: `err-chan-fix-${Date.now()}` } as any,
      payload: { action: 'voucher', channelId, amount: '100000', signature: correctSig },
    })

    log.loading('Retrying...')
    try {
      const receipt = await srvMethod.verify({
        credential: correctCred as any,
        request: ch.request,
      })
      log.success(`Claim verified (ref: ${receipt.reference})`)
    } catch (err: any) {
      log.error(`Retry failed: ${err.message}`)
    }
  }

  // ---- CASE 10 ----
  header('REPLAY_DETECTED (channel)')
  {
    log.loading('Opening PayChannel...')
    const { channelId } = await openChannel({
      seed: channelFunder.seed!,
      destination: channelReceiver.classicAddress,
      amount: '5000000',
      settleDelay: 60,
      network: NETWORK,
    })

    const store = Store.memory()
    const srvMethod = serverChannel({ publicKey: channelFunder.publicKey, network: NETWORK, store })

    const sig1 = signPaymentChannelClaim(
      channelId,
      dropsToXrp('100000').toString(),
      channelFunder.privateKey,
    )
    const ch1 = {
      id: `replay-1-${Date.now()}`,
      realm: 'error-showcase',
      method: 'xrpl' as const,
      intent: 'channel' as const,
      request: {
        amount: '100000',
        channelId,
        recipient: channelReceiver.classicAddress,
        methodDetails: { network: NETWORK, reference: crypto.randomUUID(), cumulativeAmount: '0' },
      },
    }
    const cred1 = Credential.from({
      challenge: ch1 as any,
      payload: { action: 'voucher', channelId, amount: '100000', signature: sig1 },
    })
    await srvMethod.verify({ credential: cred1 as any, request: ch1.request })
    log.success('First claim (100,000 drops) accepted')

    log.loading('Replaying same cumulative amount...')
    const ch2 = { ...ch1, id: `replay-2-${Date.now()}` }
    const cred2 = Credential.from({
      challenge: ch2 as any,
      payload: { action: 'voucher', channelId, amount: '100000', signature: sig1 },
    })
    try {
      await srvMethod.verify({ credential: cred2 as any, request: ch2.request })
      log.error('Expected error but succeeded')
    } catch (err: any) {
      log.error(err.message.slice(0, 120))
    }

    log.fix('Incrementing cumulative to 200,000 drops...')
    const sig2 = signPaymentChannelClaim(
      channelId,
      dropsToXrp('200000').toString(),
      channelFunder.privateKey,
    )
    const ch3 = { ...ch1, id: `replay-3-${Date.now()}` }
    const cred3 = Credential.from({
      challenge: ch3 as any,
      payload: { action: 'voucher', channelId, amount: '200000', signature: sig2 },
    })

    log.loading('Retrying...')
    try {
      const receipt = await srvMethod.verify({ credential: cred3 as any, request: ch3.request })
      log.success(`Claim verified (ref: ${receipt.reference})`)
    } catch (err: any) {
      log.error(`Retry failed: ${err.message}`)
    }
  }

  // ---- CASE 11 ----
  header('OVERPAY (channel)')
  {
    log.loading('Opening 1 XRP channel (deposit: 1,000,000 drops)...')
    const { channelId } = await openChannel({
      seed: channelFunder.seed!,
      destination: channelReceiver.classicAddress,
      amount: '1000000',
      settleDelay: 60,
      network: NETWORK,
    })

    // Use one store for the fail attempt
    const failStore = Store.memory()
    const failMethod = serverChannel({
      publicKey: channelFunder.publicKey,
      network: NETWORK,
      store: failStore,
    })

    log.loading('Claiming 2,000,000 drops from a 1,000,000 drop channel...')
    const overSig = signPaymentChannelClaim(
      channelId,
      dropsToXrp('2000000').toString(),
      channelFunder.privateKey,
    )
    const chOver = {
      id: `over-${Date.now()}`,
      realm: 'error-showcase',
      method: 'xrpl' as const,
      intent: 'channel' as const,
      request: {
        amount: '2000000',
        channelId,
        recipient: channelReceiver.classicAddress,
        methodDetails: { network: NETWORK, reference: crypto.randomUUID(), cumulativeAmount: '0' },
      },
    }
    const credOver = Credential.from({
      challenge: chOver as any,
      payload: { action: 'voucher', channelId, amount: '2000000', signature: overSig },
    })

    try {
      await failMethod.verify({ credential: credOver as any, request: chOver.request })
      // Signature is valid locally -- the overpay is only caught on-chain at close
      log.error('Signature valid locally, but on-chain close would fail (Balance > deposit)')
    } catch (err: any) {
      log.error(err.message.slice(0, 120))
    }

    // Fresh store for the retry so the overpay doesn't pollute cumulative tracking
    log.fix('Claiming correct amount (500,000 drops = 0.5 XRP)...')
    const retryStore = Store.memory()
    const retryMethod = serverChannel({
      publicKey: channelFunder.publicKey,
      network: NETWORK,
      store: retryStore,
    })

    const goodSig = signPaymentChannelClaim(
      channelId,
      dropsToXrp('500000').toString(),
      channelFunder.privateKey,
    )
    const chGood = {
      id: `over-fix-${Date.now()}`,
      realm: 'error-showcase',
      method: 'xrpl' as const,
      intent: 'channel' as const,
      request: {
        amount: '500000',
        channelId,
        recipient: channelReceiver.classicAddress,
        methodDetails: { network: NETWORK, reference: crypto.randomUUID(), cumulativeAmount: '0' },
      },
    }
    const credGood = Credential.from({
      challenge: chGood as any,
      payload: { action: 'voucher', channelId, amount: '500000', signature: goodSig },
    })

    log.loading('Retrying...')
    try {
      const receipt = await retryMethod.verify({
        credential: credGood as any,
        request: chGood.request,
      })
      log.success(`Claim verified (ref: ${receipt.reference})`)
    } catch (err: any) {
      log.error(`Retry failed: ${err.message}`)
    }
  }

  // ---- CASE 12 ----
  header('SERVER_REDEEM (channel -- client disappears)')
  {
    log.loading('Opening PayChannel (5 XRP)...')
    const { channelId, txHash: createHash } = await openChannel({
      seed: channelFunder.seed!,
      destination: channelReceiver.classicAddress,
      amount: '5000000',
      settleDelay: 60,
      network: NETWORK,
    })
    log.tx(createHash, log.explorerLink(createHash))

    const store = Store.memory()
    const srvMethod = serverChannel({ publicKey: channelFunder.publicKey, network: NETWORK, store })

    // Client makes 3 claims then disappears
    let lastSig = ''
    let lastAmount = '0'
    for (const cumDrops of ['100000', '200000', '300000']) {
      const sig = signPaymentChannelClaim(
        channelId,
        dropsToXrp(cumDrops).toString(),
        channelFunder.privateKey,
      )
      const ch = {
        id: `redeem-${cumDrops}-${Date.now()}`,
        realm: 'error-showcase',
        method: 'xrpl' as const,
        intent: 'channel' as const,
        request: {
          amount: '100000',
          channelId,
          recipient: channelReceiver.classicAddress,
          methodDetails: {
            network: NETWORK,
            reference: crypto.randomUUID(),
            cumulativeAmount: lastAmount,
          },
        },
      }
      const cred = Credential.from({
        challenge: ch as any,
        payload: { action: 'voucher', channelId, amount: cumDrops, signature: sig },
      })
      await srvMethod.verify({ credential: cred as any, request: ch.request })
      lastSig = sig
      lastAmount = cumDrops
    }
    log.success(`Client made 3 claims (cumulative: ${lastAmount} drops), then disappeared`)

    // Verify the store has the latest signature
    const storeState = (await store.get(`xrpl:channel:${channelId}`)) as any
    log.info(
      `Store has cumulative=${storeState.cumulative}, signature=${storeState.signature.slice(0, 16)}...`,
    )

    // Server redeems using stored signature + its own seed
    log.loading('Server redeems funds on-chain using stored claim...')
    const { close } = await import('../sdk/src/channel/server/Channel.js')
    const { txHash: redeemHash } = await close({
      seed: channelReceiver.seed!,
      channelId,
      amount: storeState.cumulative,
      signature: storeState.signature,
      channelPublicKey: channelFunder.publicKey,
      network: NETWORK,
    })
    log.success('Server redeemed funds on-chain')
    log.tx(redeemHash, log.explorerLink(redeemHash))

    // Verify receiver balance increased
    const receiverInfo = await xrpl.request({
      command: 'account_info',
      account: channelReceiver.classicAddress,
    })
    log.info(
      `Receiver balance: ${dropsToXrp(receiverInfo.result.account_data.Balance as string)} XRP`,
    )
  }

  await xrpl.disconnect()
  log.separator()
  log.box(['All 12 error cases completed'])
  process.exit(0)
}

main().catch((err) => {
  log.error(`Fatal: ${err}`)
  process.exit(1)
})
