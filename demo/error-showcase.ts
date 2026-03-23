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

const EXPLORER = 'https://testnet.xrpl.org/transactions/'
const NETWORK = 'testnet'
const RPC = XRPL_RPC_URLS[NETWORK]

let caseNum = 0
const totalCases = 11

function header(name: string) {
  caseNum++
  console.log(`\n[${caseNum}/${totalCases}] ${name}`)
}

function fail(msg: string) {
  console.log(`  -> FAIL: ${msg}`)
}

function fix(msg: string) {
  console.log(`  -> Fix: ${msg}`)
}

function pass(hash: string) {
  console.log(`  -> PASS: tx ${hash}`)
  console.log(`     ${EXPLORER}${hash}`)
}

function retry() {
  console.log('  -> Retry...')
}

// -- Helpers for in-process charge flow --

async function runChargeFlow(params: {
  clientSeed: string
  recipient: string
  amount: string
  currency: string
  serverCurrency?: any
}): Promise<{ hash: string }> {
  const { clientSeed, recipient, amount, currency, serverCurrency } = params

  const store = Store.memory()
  const server = serverCharge({
    recipient,
    currency: serverCurrency,
    network: NETWORK,
    store,
  })

  const client = clientCharge({
    seed: clientSeed,
    mode: 'pull',
    network: NETWORK,
  })

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

  const credentialStr = await client.createCredential({ challenge })
  const credential = Credential.deserialize(credentialStr)

  const receipt = await server.verify({
    credential: credential as any,
    request: challenge.request,
  })

  return { hash: receipt.reference }
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  console.log('=== Error Showcase ===')
  console.log('Generating wallets on XRPL testnet...\n')

  const xrpl = new Client(RPC)
  await xrpl.connect()

  // Fund the wallets we need
  const { wallet: mainWallet } = await xrpl.fundWallet()
  const { wallet: recipientWallet } = await xrpl.fundWallet()
  const { wallet: issuerWallet } = await xrpl.fundWallet()
  const { wallet: channelFunder } = await xrpl.fundWallet()
  const { wallet: channelReceiver } = await xrpl.fundWallet()
  const wrongSigner = Wallet.generate() // NOT funded, just for wrong-key test

  console.log(`Main wallet:      ${mainWallet.classicAddress}`)
  console.log(`Recipient:        ${recipientWallet.classicAddress}`)
  console.log(`Issuer:           ${issuerWallet.classicAddress}`)
  console.log(`Channel funder:   ${channelFunder.classicAddress}`)
  console.log(`Channel receiver: ${channelReceiver.classicAddress}`)

  // ========================================================================
  // CASE 1: INSUFFICIENT_BALANCE
  // ========================================================================
  header('INSUFFICIENT_BALANCE')
  {
    console.log('  -> Attempting payment with unfunded wallet...')
    const unfunded = Wallet.generate()
    try {
      await runChargeFlow({
        clientSeed: unfunded.seed!,
        recipient: recipientWallet.classicAddress,
        amount: '1000000',
        currency: 'XRP',
      })
      fail('Expected error but succeeded')
    } catch (err: any) {
      fail(`${err.message.slice(0, 120)}`)
    }

    fix('funding wallet via testnet faucet...')
    await xrpl.fundWallet(unfunded)

    retry()
    try {
      const { hash } = await runChargeFlow({
        clientSeed: unfunded.seed!,
        recipient: recipientWallet.classicAddress,
        amount: '1000000',
        currency: 'XRP',
      })
      pass(hash)
    } catch (err: any) {
      fail(`Retry failed: ${err.message}`)
    }
  }

  // ========================================================================
  // CASE 2: RECIPIENT_NOT_FOUND
  // ========================================================================
  header('RECIPIENT_NOT_FOUND')
  {
    const nonExistent = Wallet.generate()
    console.log(`  -> Attempting payment to non-existent address ${nonExistent.classicAddress}...`)
    try {
      await runChargeFlow({
        clientSeed: mainWallet.seed!,
        recipient: nonExistent.classicAddress,
        amount: '1000000',
        currency: 'XRP',
      })
      fail('Expected error but succeeded')
    } catch (err: any) {
      fail(`${err.message.slice(0, 120)}`)
    }

    fix('funding destination account...')
    await xrpl.fundWallet(nonExistent)

    retry()
    try {
      const { hash } = await runChargeFlow({
        clientSeed: mainWallet.seed!,
        recipient: nonExistent.classicAddress,
        amount: '1000000',
        currency: 'XRP',
      })
      pass(hash)
    } catch (err: any) {
      fail(`Retry failed: ${err.message}`)
    }
  }

  // ========================================================================
  // CASE 3: Wrong amount (client pays less than challenged)
  // ========================================================================
  header('AMOUNT_MISMATCH')
  {
    console.log('  -> Client signs tx for 1 drop but server expects 1000000 drops...')
    const store = Store.memory()
    const server = serverCharge({
      recipient: recipientWallet.classicAddress,
      network: NETWORK,
      store,
    })

    // Client signs for the WRONG amount (1 drop instead of 1000000)
    const clientMethod = clientCharge({ seed: mainWallet.seed!, mode: 'pull', network: NETWORK })
    const wrongChallenge = {
      id: `err-amt-${Date.now()}`,
      realm: 'error-showcase',
      method: 'xrpl' as const,
      intent: 'charge' as const,
      request: {
        amount: '1', // Client signs for 1 drop
        currency: 'XRP',
        recipient: recipientWallet.classicAddress,
        methodDetails: { network: NETWORK, reference: crypto.randomUUID() },
      },
    }
    const credStr = await clientMethod.createCredential({ challenge: wrongChallenge })
    const cred = Credential.deserialize(credStr)

    // Server expects 1000000 drops
    try {
      await server.verify({
        credential: cred as any,
        request: { ...wrongChallenge.request, amount: '1000000' },
      })
      fail('Expected error but succeeded')
    } catch (err: any) {
      fail(`${err.message.slice(0, 120)}`)
    }

    fix('client signs correct amount (1000000 drops)...')
    retry()
    try {
      const { hash } = await runChargeFlow({
        clientSeed: mainWallet.seed!,
        recipient: recipientWallet.classicAddress,
        amount: '1000000',
        currency: 'XRP',
      })
      pass(hash)
    } catch (err: any) {
      fail(`Retry failed: ${err.message}`)
    }
  }

  // ========================================================================
  // CASE 4: MISSING_TRUSTLINE
  // ========================================================================
  header('MISSING_TRUSTLINE')
  {
    // Set up issuer with DefaultRipple
    console.log('  -> Setting up issuer with DefaultRipple...')
    await xrpl.submitAndWait(
      { TransactionType: 'AccountSet', Account: issuerWallet.classicAddress, SetFlag: 8 },
      { wallet: issuerWallet },
    )
    // Recipient needs trustline
    await xrpl.submitAndWait(
      {
        TransactionType: 'TrustSet',
        Account: recipientWallet.classicAddress,
        LimitAmount: { currency: 'USD', issuer: issuerWallet.classicAddress, value: '1000000' },
      },
      { wallet: recipientWallet },
    )

    // Client does NOT have trustline
    const { wallet: noTrustClient } = await xrpl.fundWallet()
    console.log('  -> Attempting IOU payment without client trustline...')
    const currencyJson = JSON.stringify({ currency: 'USD', issuer: issuerWallet.classicAddress })
    try {
      await runChargeFlow({
        clientSeed: noTrustClient.seed!,
        recipient: recipientWallet.classicAddress,
        amount: '10',
        currency: currencyJson,
        serverCurrency: { currency: 'USD', issuer: issuerWallet.classicAddress },
      })
      fail('Expected error but succeeded')
    } catch (err: any) {
      fail(`${err.message.slice(0, 120)}`)
    }

    fix('creating trustline for client...')
    await xrpl.submitAndWait(
      {
        TransactionType: 'TrustSet',
        Account: noTrustClient.classicAddress,
        LimitAmount: { currency: 'USD', issuer: issuerWallet.classicAddress, value: '1000000' },
      },
      { wallet: noTrustClient },
    )
    // Issue tokens to this client
    await xrpl.submitAndWait(
      {
        TransactionType: 'Payment',
        Account: issuerWallet.classicAddress,
        Destination: noTrustClient.classicAddress,
        Amount: { currency: 'USD', issuer: issuerWallet.classicAddress, value: '1000' },
      },
      { wallet: issuerWallet },
    )

    retry()
    try {
      const { hash } = await runChargeFlow({
        clientSeed: noTrustClient.seed!,
        recipient: recipientWallet.classicAddress,
        amount: '10',
        currency: currencyJson,
        serverCurrency: { currency: 'USD', issuer: issuerWallet.classicAddress },
      })
      pass(hash)
    } catch (err: any) {
      fail(`Retry failed: ${err.message}`)
    }
  }

  // ========================================================================
  // CASE 5: PAYMENT_PATH_FAILED (rippling disabled)
  // ========================================================================
  header('PAYMENT_PATH_FAILED')
  {
    // Create a NEW issuer WITHOUT DefaultRipple
    const { wallet: badIssuer } = await xrpl.fundWallet()
    const { wallet: pathClient } = await xrpl.fundWallet()
    const { wallet: pathRecipient } = await xrpl.fundWallet()

    console.log('  -> Setting up IOU with rippling DISABLED on issuer...')
    // Create trustlines
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
    // Issue tokens
    await xrpl.submitAndWait(
      {
        TransactionType: 'Payment',
        Account: badIssuer.classicAddress,
        Destination: pathClient.classicAddress,
        Amount: { currency: 'TST', issuer: badIssuer.classicAddress, value: '1000' },
      },
      { wallet: badIssuer },
    )

    console.log('  -> Attempting IOU payment (rippling disabled)...')
    const currencyJson = JSON.stringify({ currency: 'TST', issuer: badIssuer.classicAddress })
    try {
      await runChargeFlow({
        clientSeed: pathClient.seed!,
        recipient: pathRecipient.classicAddress,
        amount: '10',
        currency: currencyJson,
        serverCurrency: { currency: 'TST', issuer: badIssuer.classicAddress },
      })
      fail('Expected error but succeeded')
    } catch (err: any) {
      fail(`${err.message.slice(0, 120)}`)
    }

    fix('enabling DefaultRipple on issuer...')
    await xrpl.submitAndWait(
      { TransactionType: 'AccountSet', Account: badIssuer.classicAddress, SetFlag: 8 },
      { wallet: badIssuer },
    )

    retry()
    try {
      const { hash } = await runChargeFlow({
        clientSeed: pathClient.seed!,
        recipient: pathRecipient.classicAddress,
        amount: '10',
        currency: currencyJson,
        serverCurrency: { currency: 'TST', issuer: badIssuer.classicAddress },
      })
      pass(hash)
    } catch (err: any) {
      fail(`Retry failed: ${err.message}`)
    }
  }

  // ========================================================================
  // CASE 6: Insufficient IOU balance
  // ========================================================================
  header('INSUFFICIENT_IOU_BALANCE')
  {
    const { wallet: emptyClient } = await xrpl.fundWallet()
    console.log('  -> Client has trustline but zero token balance...')
    // Trustline but NO tokens
    await xrpl.submitAndWait(
      {
        TransactionType: 'TrustSet',
        Account: emptyClient.classicAddress,
        LimitAmount: { currency: 'USD', issuer: issuerWallet.classicAddress, value: '1000000' },
      },
      { wallet: emptyClient },
    )

    const currencyJson = JSON.stringify({ currency: 'USD', issuer: issuerWallet.classicAddress })
    try {
      await runChargeFlow({
        clientSeed: emptyClient.seed!,
        recipient: recipientWallet.classicAddress,
        amount: '10',
        currency: currencyJson,
        serverCurrency: { currency: 'USD', issuer: issuerWallet.classicAddress },
      })
      fail('Expected error but succeeded')
    } catch (err: any) {
      fail(`${err.message.slice(0, 120)}`)
    }

    fix('issuer sends tokens to client...')
    await xrpl.submitAndWait(
      {
        TransactionType: 'Payment',
        Account: issuerWallet.classicAddress,
        Destination: emptyClient.classicAddress,
        Amount: { currency: 'USD', issuer: issuerWallet.classicAddress, value: '1000' },
      },
      { wallet: issuerWallet },
    )

    retry()
    try {
      const { hash } = await runChargeFlow({
        clientSeed: emptyClient.seed!,
        recipient: recipientWallet.classicAddress,
        amount: '10',
        currency: currencyJson,
        serverCurrency: { currency: 'USD', issuer: issuerWallet.classicAddress },
      })
      pass(hash)
    } catch (err: any) {
      fail(`Retry failed: ${err.message}`)
    }
  }

  // ========================================================================
  // CASE 7: MPT not authorized
  // ========================================================================
  header('MPT_NOT_AUTHORIZED')
  {
    console.log('  -> Creating MPT issuance...')
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

    // Authorize recipient but NOT client
    await xrpl.submitAndWait(
      {
        TransactionType: 'MPTokenAuthorize' as any,
        Account: mptRecipient.classicAddress,
        MPTokenIssuanceID: mptId,
      },
      { wallet: mptRecipient },
    )

    console.log('  -> Attempting MPT payment without client authorization...')
    const currencyJson = JSON.stringify({ mpt_issuance_id: mptId })
    try {
      await runChargeFlow({
        clientSeed: mptClient.seed!,
        recipient: mptRecipient.classicAddress,
        amount: '100',
        currency: currencyJson,
        serverCurrency: { mpt_issuance_id: mptId },
      })
      fail('Expected error but succeeded')
    } catch (err: any) {
      fail(`${err.message.slice(0, 120)}`)
    }

    fix('authorizing client for MPT...')
    await xrpl.submitAndWait(
      {
        TransactionType: 'MPTokenAuthorize' as any,
        Account: mptClient.classicAddress,
        MPTokenIssuanceID: mptId,
      },
      { wallet: mptClient },
    )
    // Issue tokens
    await xrpl.submitAndWait(
      {
        TransactionType: 'Payment',
        Account: mptIssuer.classicAddress,
        Destination: mptClient.classicAddress,
        Amount: { mpt_issuance_id: mptId, value: '10000' } as any,
      },
      { wallet: mptIssuer },
    )

    retry()
    try {
      const { hash } = await runChargeFlow({
        clientSeed: mptClient.seed!,
        recipient: mptRecipient.classicAddress,
        amount: '100',
        currency: currencyJson,
        serverCurrency: { mpt_issuance_id: mptId },
      })
      pass(hash)
    } catch (err: any) {
      fail(`Retry failed: ${err.message}`)
    }
  }

  // ========================================================================
  // CASE 8: Insufficient MPT balance
  // ========================================================================
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

    // Authorize both but give NO tokens to client
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

    console.log('  -> Client authorized but has zero MPT balance...')
    const currencyJson = JSON.stringify({ mpt_issuance_id: mptId2 })
    try {
      await runChargeFlow({
        clientSeed: mptEmpty.seed!,
        recipient: mptRecip2.classicAddress,
        amount: '100',
        currency: currencyJson,
        serverCurrency: { mpt_issuance_id: mptId2 },
      })
      fail('Expected error but succeeded')
    } catch (err: any) {
      fail(`${err.message.slice(0, 120)}`)
    }

    fix('issuer mints tokens to client...')
    await xrpl.submitAndWait(
      {
        TransactionType: 'Payment',
        Account: mptIssuer2.classicAddress,
        Destination: mptEmpty.classicAddress,
        Amount: { mpt_issuance_id: mptId2, value: '10000' } as any,
      },
      { wallet: mptIssuer2 },
    )

    retry()
    try {
      const { hash } = await runChargeFlow({
        clientSeed: mptEmpty.seed!,
        recipient: mptRecip2.classicAddress,
        amount: '100',
        currency: currencyJson,
        serverCurrency: { mpt_issuance_id: mptId2 },
      })
      pass(hash)
    } catch (err: any) {
      fail(`Retry failed: ${err.message}`)
    }
  }

  // ========================================================================
  // CASE 9: Wrong signer (channel)
  // ========================================================================
  header('WRONG_SIGNER (channel)')
  {
    console.log('  -> Opening a PayChannel...')
    const { channelId, txHash: createHash } = await openChannel({
      seed: channelFunder.seed!,
      destination: channelReceiver.classicAddress,
      amount: '5000000',
      settleDelay: 60,
      network: NETWORK,
    })
    console.log(`     Channel: ${channelId}  (${EXPLORER}${createHash})`)

    const store = Store.memory()
    const serverMethod = serverChannel({
      publicKey: channelFunder.publicKey,
      network: NETWORK,
      store,
    })

    // Sign with WRONG key
    console.log('  -> Signing claim with wrong wallet...')
    const wrongSig = signPaymentChannelClaim(
      channelId,
      dropsToXrp('100000').toString(),
      wrongSigner.privateKey,
    )

    const challenge = {
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
      challenge: challenge as any,
      payload: { action: 'voucher', channelId, amount: '100000', signature: wrongSig },
    })

    try {
      await serverMethod.verify({ credential: wrongCred as any, request: challenge.request })
      fail('Expected error but succeeded')
    } catch (err: any) {
      fail(`${err.message.slice(0, 120)}`)
    }

    fix('signing with correct wallet...')
    const correctSig = signPaymentChannelClaim(
      channelId,
      dropsToXrp('100000').toString(),
      channelFunder.privateKey,
    )
    const correctCred = Credential.from({
      challenge: { ...challenge, id: `err-chan-fix-${Date.now()}` } as any,
      payload: { action: 'voucher', channelId, amount: '100000', signature: correctSig },
    })

    retry()
    try {
      const receipt = await serverMethod.verify({
        credential: correctCred as any,
        request: challenge.request,
      })
      console.log(`  -> PASS: claim verified (ref: ${receipt.reference})`)
    } catch (err: any) {
      fail(`Retry failed: ${err.message}`)
    }
  }

  // ========================================================================
  // CASE 10: Replay (same cumulative twice)
  // ========================================================================
  header('REPLAY_DETECTED (channel)')
  {
    console.log('  -> Opening a PayChannel...')
    const { channelId } = await openChannel({
      seed: channelFunder.seed!,
      destination: channelReceiver.classicAddress,
      amount: '5000000',
      settleDelay: 60,
      network: NETWORK,
    })

    const store = Store.memory()
    const serverMethod = serverChannel({
      publicKey: channelFunder.publicKey,
      network: NETWORK,
      store,
    })

    // First claim: 100000 drops
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
    await serverMethod.verify({ credential: cred1 as any, request: ch1.request })
    console.log('  -> First claim (100000 drops) accepted.')

    // Replay: same cumulative
    console.log('  -> Replaying same cumulative amount...')
    const ch2 = { ...ch1, id: `replay-2-${Date.now()}` }
    const cred2 = Credential.from({
      challenge: ch2 as any,
      payload: { action: 'voucher', channelId, amount: '100000', signature: sig1 },
    })
    try {
      await serverMethod.verify({ credential: cred2 as any, request: ch2.request })
      fail('Expected error but succeeded')
    } catch (err: any) {
      fail(`${err.message.slice(0, 120)}`)
    }

    fix('incrementing cumulative to 200000 drops...')
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

    retry()
    try {
      const receipt = await serverMethod.verify({ credential: cred3 as any, request: ch3.request })
      console.log(`  -> PASS: claim verified (ref: ${receipt.reference})`)
    } catch (err: any) {
      fail(`Retry failed: ${err.message}`)
    }
  }

  // ========================================================================
  // CASE 11: Overpay (claim > channel deposit)
  // ========================================================================
  header('OVERPAY (channel)')
  {
    console.log('  -> Opening a 1 XRP channel...')
    const { channelId } = await openChannel({
      seed: channelFunder.seed!,
      destination: channelReceiver.classicAddress,
      amount: '1000000', // 1 XRP
      settleDelay: 60,
      network: NETWORK,
    })

    const store = Store.memory()
    const serverMethod = serverChannel({
      publicKey: channelFunder.publicKey,
      network: NETWORK,
      store,
    })

    // Claim 2 XRP (more than the 1 XRP deposit)
    console.log('  -> Claiming 2 XRP from a 1 XRP channel...')
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

    // The signature is technically valid (signed by correct key), so local verify passes.
    // The overpay would only be caught on-chain during close.
    // For the demo, we verify locally and show it passes the signature check,
    // then explain that overpay protection happens at close time.
    try {
      await serverMethod.verify({ credential: credOver as any, request: chOver.request })
      // If it passes, note that on-chain close would fail
      console.log('  -> NOTE: Signature valid, but on-chain close would fail for amount > deposit.')
      console.log('     PaymentChannelClaim with Balance > channel Amount returns tecUNFUNDED.')
    } catch (err: any) {
      fail(`${err.message.slice(0, 120)}`)
    }

    fix('claiming correct amount (500000 drops = 0.5 XRP)...')
    const goodSig = signPaymentChannelClaim(
      channelId,
      dropsToXrp('500000').toString(),
      channelFunder.privateKey,
    )
    const chGood = {
      ...chOver,
      id: `over-fix-${Date.now()}`,
      request: { ...chOver.request, amount: '500000' },
    }
    const credGood = Credential.from({
      challenge: chGood as any,
      payload: { action: 'voucher', channelId, amount: '500000', signature: goodSig },
    })

    retry()
    try {
      const receipt = await serverMethod.verify({
        credential: credGood as any,
        request: chGood.request,
      })
      console.log(`  -> PASS: claim verified (ref: ${receipt.reference})`)
    } catch (err: any) {
      fail(`Retry failed: ${err.message}`)
    }
  }

  // ========================================================================
  // DONE
  // ========================================================================
  await xrpl.disconnect()
  console.log('\n=== All 11 error cases completed ===')
  process.exit(0)
}

main().catch((err) => {
  console.error('Error showcase failed:', err)
  process.exit(1)
})
