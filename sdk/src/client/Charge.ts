import { Credential, Method } from 'mppx'
import type { Payment } from 'xrpl'
import { Client, Wallet } from 'xrpl'
import { z } from 'zod/mini'
import { type NetworkId, XRPL_RPC_URLS } from '../constants.js'
import { fromTecResult } from '../errors.js'
import * as Methods from '../Methods.js'
import type { ChargeClientConfig, PaymentMode } from '../types.js'
import { buildAmount, parseCurrency } from '../utils/currency.js'
import { runPreflight } from '../utils/validation.js'

/**
 * XRPL charge method for the client.
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
    preflight: runPreflightCheck = true,
    network: defaultNetwork = 'testnet',
    rpcUrl: defaultRpcUrl,
    onProgress,
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

      onProgress?.({ type: 'challenge', recipient, amount, currency: currencyStr })

      const client = new Client(rpcUrl)
      await client.connect()

      try {
        if (runPreflightCheck) {
          onProgress?.({ type: 'preflight' })
          await runPreflight({
            client,
            wallet,
            currency,
            destination: recipient,
            amount,
          })
        }

        const payment = {
          TransactionType: 'Payment' as const,
          Account: wallet.classicAddress,
          Destination: recipient,
          Amount: xrplAmount,
          ...(request.methodDetails?.invoiceId
            ? { InvoiceID: request.methodDetails.invoiceId }
            : {}),
        }

        const prepared = await client.autofill(payment as Payment)

        onProgress?.({ type: 'signing' })
        const signed = wallet.sign(prepared)
        const effectiveMode: PaymentMode = context?.mode ?? defaultMode
        onProgress?.({ type: 'signed', mode: effectiveMode })

        if (effectiveMode === 'push') {
          onProgress?.({ type: 'submitting' })
          const result = await client.submitAndWait(signed.tx_blob)
          const meta = result.result.meta as any
          if (meta?.TransactionResult !== 'tesSUCCESS') {
            throw fromTecResult(
              meta?.TransactionResult ?? 'unknown',
              `Transaction failed: ${meta?.TransactionResult ?? 'unknown'}`,
            )
          }

          onProgress?.({ type: 'confirmed', hash: signed.hash })

          return Credential.serialize({
            challenge,
            payload: { type: 'hash' as const, hash: signed.hash },
            source: `did:pkh:xrpl:${network}:${wallet.classicAddress}`,
          })
        }

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
