import { Credential, Method } from 'mppx'
import type { Payment } from 'xrpl'
import { Client, Wallet } from 'xrpl'
import { z } from 'zod/mini'
import { type NetworkId, XRPL_RPC_URLS } from '../constants.js'
import { fromTecResult } from '../errors.js'
import * as Methods from '../Methods.js'
import type { ChargeClientConfig, PaymentMode } from '../types.js'
import { buildAmount, isIOU, parseCurrency } from '../utils/currency.js'
import { resolveIouPaymentExtras, validateSlippageBps } from '../utils/paths.js'
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
    slippageBps = 50,
    network: defaultNetwork = 'testnet',
    rpcUrl: defaultRpcUrl,
    onProgress,
  } = parameters

  if (!seed) {
    throw new Error('seed is required for client charge method.')
  }

  validateSlippageBps(slippageBps)

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

        // For IOU payments, resolve Paths + SendMax before signing. This covers
        // cross-issuer payments (path-find + chosen alternative) and same-issuer
        // payments where the issuer charges a TransferRate.
        let pathsField: { Paths?: unknown; SendMax?: unknown } = {}
        if (isIOU(currency) && typeof xrplAmount === 'object' && 'currency' in xrplAmount) {
          onProgress?.({ type: 'pathfinding' })
          const extras = await resolveIouPaymentExtras({
            client,
            sender: wallet.classicAddress,
            recipient,
            destinationAmount: xrplAmount,
            slippageBps,
          })
          pathsField = {
            ...(extras.Paths ? { Paths: extras.Paths } : {}),
            ...(extras.SendMax ? { SendMax: extras.SendMax } : {}),
          }
          onProgress?.({
            type: 'paths_resolved',
            strategy: extras.strategy,
            sourceAmountValue: extras.sourceAmountValue,
            sourceAmountCurrency: extras.sourceAmountCurrency,
          })
        }

        const payment = {
          TransactionType: 'Payment' as const,
          Account: wallet.classicAddress,
          Destination: recipient,
          Amount: xrplAmount,
          ...pathsField,
          ...(request.methodDetails?.invoiceId
            ? { InvoiceID: request.methodDetails.invoiceId }
            : {}),
          ...(request.methodDetails?.destinationTag !== undefined
            ? { DestinationTag: request.methodDetails.destinationTag }
            : {}),
          ...(request.methodDetails?.sourceTag !== undefined
            ? { SourceTag: request.methodDetails.sourceTag }
            : {}),
          ...(request.methodDetails?.memos && request.methodDetails.memos.length > 0
            ? { Memos: encodeMemos(request.methodDetails.memos) }
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

type ChallengeMemo = { type?: string; format?: string; data?: string }

/**
 * Encode UTF-8 memo fields as hex per XRPL Memos[].Memo encoding. Each field
 * is optional; absent fields are dropped from the encoded entry.
 */
function encodeMemos(
  memos: ChallengeMemo[],
): Array<{ Memo: { MemoType?: string; MemoFormat?: string; MemoData?: string } }> {
  return memos.map((m) => {
    const memo: { MemoType?: string; MemoFormat?: string; MemoData?: string } = {}
    if (m.type) memo.MemoType = utf8ToHex(m.type)
    if (m.format) memo.MemoFormat = utf8ToHex(m.format)
    if (m.data) memo.MemoData = utf8ToHex(m.data)
    return { Memo: memo }
  })
}

function utf8ToHex(s: string): string {
  return Buffer.from(s, 'utf8').toString('hex').toUpperCase()
}
