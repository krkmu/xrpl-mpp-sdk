import { Credential, Method } from 'mppx'
import type { Payment } from 'xrpl'
import { Client, Wallet } from 'xrpl'
import { z } from 'zod/mini'
import { type NetworkId, XRPL_RPC_URLS } from '../constants.js'
import * as Methods from '../Methods.js'
import type { ChargeClientConfig, PaymentMode } from '../types.js'
import { buildAmount, parseCurrency } from '../utils/currency.js'
import { runPreflight } from '../utils/validation.js'

/**
 * Creates an XRPL charge method for use on the **client**.
 *
 * Builds a Payment transaction, signs it, and either:
 * - **pull** (default): sends the signed blob to the server to submit
 * - **push**: submits itself and sends the tx hash
 *
 * @example
 * ```ts
 * import { Mppx } from 'mppx/client'
 * import { xrpl } from 'xrpl-mpp-sdk/client'
 *
 * const mppx = Mppx.create({
 *   methods: [
 *     xrpl.charge({ seed: 'sEdV...' }),
 *   ],
 * })
 * ```
 */
export function charge(parameters: charge.Parameters) {
  const {
    seed,
    mode: defaultMode = 'pull',
    autoTrustline = false,
    autoTrustlineLimit,
    autoMPTAuthorize = false,
    preflight: runPreflightCheck = false,
    network: defaultNetwork = 'testnet',
    rpcUrl: defaultRpcUrl,
  } = parameters

  if (!seed) {
    throw new Error('seed is required for client charge method.')
  }

  const wallet = Wallet.fromSeed(seed)

  return Method.toClient(Methods.charge, {
    context: z.object({
      mode: z.optional(z.enum(['push', 'pull'])),
    }),
    async createCredential({ challenge, context }) {
      const { request } = challenge
      const { amount, currency: currencyStr, recipient } = request
      const network = (request.methodDetails?.network as NetworkId) ?? defaultNetwork
      const rpcUrl = defaultRpcUrl ?? XRPL_RPC_URLS[network]

      const currency = parseCurrency(currencyStr)
      const xrplAmount = buildAmount(amount, currency)

      const client = new Client(rpcUrl)
      await client.connect()

      try {
        // Pre-flight validation
        if (runPreflightCheck) {
          await runPreflight({
            client,
            wallet,
            currency,
            destination: recipient,
            autoTrustline,
            autoTrustlineLimit,
            autoMPTAuthorize,
          })
        }

        // Build Payment transaction
        const payment = {
          TransactionType: 'Payment' as const,
          Account: wallet.classicAddress,
          Destination: recipient,
          Amount: xrplAmount,
          ...(request.methodDetails?.invoiceId
            ? { InvoiceID: request.methodDetails.invoiceId }
            : {}),
        }

        // Autofill Sequence, Fee, LastLedgerSequence
        const prepared = await client.autofill(payment as Payment)

        // Sign the transaction
        const signed = wallet.sign(prepared)
        const effectiveMode: PaymentMode = context?.mode ?? defaultMode

        if (effectiveMode === 'push') {
          // Client broadcasts
          const result = await client.submitAndWait(signed.tx_blob)
          const meta = result.result.meta as any
          if (meta?.TransactionResult !== 'tesSUCCESS') {
            throw new Error(`Transaction failed: ${meta?.TransactionResult ?? 'unknown'}`)
          }

          return Credential.serialize({
            challenge,
            payload: { type: 'hash' as const, hash: signed.hash },
            source: `did:pkh:xrpl:${network}:${wallet.classicAddress}`,
          })
        }

        // Pull mode: send signed blob for server to submit
        return Credential.serialize({
          challenge,
          payload: { type: 'transaction' as const, blob: signed.tx_blob },
          source: `did:pkh:xrpl:${network}:${wallet.classicAddress}`,
        })
      } finally {
        await client.disconnect()
      }
    },
  })
}

export declare namespace charge {
  export type Parameters = ChargeClientConfig
}
