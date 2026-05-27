/**
 * Weather API (RLUSD charge) -- Client
 *
 * Consumer of the RLUSD-billed weather API. Same wire flow as
 * `../weather-api/client.ts`, but the payer wallet is loaded from
 * `.env` (`PAYER_SEED`) instead of being faucet-funded, because Ripple
 * does not expose a programmatic faucet for RLUSD -- the test wallet
 * must already hold some.
 *
 *   Traditional SaaS API:   Authorization: Bearer sk-... + invoice end of month
 *   This API:               HTTP 402 -> 0.1 RLUSD on-chain -> 200 + forecast
 *
 * Bootstrap (one-time, before any paid call):
 *   1. Load the payer wallet from `PAYER_SEED` in `.env`. The wallet
 *      must already hold:
 *        - ~10 XRP (for the trustline reserve + per-tx fees)
 *        - some testnet RLUSD (from https://tryrlusd.com or any
 *          account you fund yourself)
 *   2. GET /info to discover marketplace address, RLUSD currency, pricing.
 *   3. Open (or confirm) a trustline to the RLUSD issuer
 *      (`acceptToken` / TrustSet). Idempotent -- returns `unchanged`
 *      when the trustline already exists at the expected limit.
 *   4. Sanity-check the payer's RLUSD balance and abort early with a
 *      clear pointer to the testnet faucet if it is zero.
 *
 * Then for each city in CITIES we POST /forecast. mppx intercepts the
 * 402, signs an RLUSD `Payment` for 0.1 RLUSD, submits to XRPL, polls
 * until validated, and retries the request transparently. The
 * settlement summary at the end shows per-call tx hashes and total
 * RLUSD spent.
 *
 * Run: npx tsx demo/weather-api-rlusd/client.ts
 *      (after `npx tsx demo/weather-api-rlusd/server.ts`)
 */
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
import { Receipt } from 'mppx'
import { Mppx } from 'mppx/client'
import { charge } from '../../sdk/src/client/Charge.js'
import { Wallet } from '../../sdk/src/utils/wallet.js'
import * as log from '../log.js'

const HERE = dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: resolve(HERE, '.env') })

const PORT = 3010
const BASE = `http://localhost:${PORT}`
const NETWORK = 'testnet' as const

const rawFetch = globalThis.fetch

/**
 * Cities to query. Edit this list to exercise more or fewer paid calls.
 * The server only knows about its built-in KNOWN_CITIES; any other name
 * will still bill and return a deterministic mock forecast.
 */
const CITIES = ['Chamonix', 'Verbier', 'Zermatt']

type Forecast = {
  city: string
  date: string
  temperature_c: number
  condition: string
  wind_kmh: number
  fresh_snow_cm: number
  visibility_km: number
  premium_advice: string
}

type Info = {
  recipient: string
  network: string
  currency: { currency: string; issuer: string }
  /** Human-readable name (e.g. `RLUSD`) for log lines. `currency.currency` is the 40-char hex wire form. */
  currencyDisplay: string
  pricePerCallRlusd: string
  payerTrustlineLimitRlusd: string
  knownCities: string[]
}

type CallRecord = {
  city: string
  pricePaidRlusd: string
  txHash: string
  forecast: Forecast | null
  error?: string
}

async function fetchInfo(): Promise<Info> {
  const res = await rawFetch(`${BASE}/info`)
  if (!res.ok) throw new Error(`/info failed: ${res.status}`)
  return (await res.json()) as Info
}

/**
 * Load the payer wallet from PAYER_SEED. Required: this demo cannot
 * faucet RLUSD for you (Ripple does not expose a programmatic faucet).
 */
function loadPayer(): Wallet {
  const seed = process.env.PAYER_SEED
  if (!seed || seed.startsWith('sEd...')) {
    log.error('PAYER_SEED is missing or still the placeholder.')
    log.info('Copy demo/weather-api-rlusd/.env.example to .env and paste a testnet seed')
    log.info('whose address already holds some RLUSD (see https://tryrlusd.com).')
    process.exit(1)
  }
  return Wallet.fromSeed(seed)
}

/**
 * Call /forecast for a single city. mppx intercepts the 402 silently:
 * reads the RLUSD challenge, signs an IOU Payment, submits to XRPL,
 * retries the request once the tx is validated.
 */
async function getForecast(
  city: string,
  price: string,
  displayCurrency: string,
): Promise<CallRecord> {
  log.loading(`GET forecast("${city}") -- mppx will auto-pay ${price} ${displayCurrency}...`)
  const response = await fetch(`${BASE}/forecast`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ city }),
  })

  if (!response.ok) {
    const errText = await response.text().catch(() => '')
    log.error(`Request failed: ${response.status} ${errText}`)
    return {
      city,
      pricePaidRlusd: '0',
      txHash: '',
      forecast: null,
      error: `${response.status} ${errText}`,
    }
  }

  let txHash = ''
  try {
    const receipt = Receipt.fromResponse(response)
    txHash = receipt.reference
    log.tx(txHash, log.explorerLink(txHash))
  } catch {
    // No receipt header -- continue, just lose the explorer link.
  }

  const forecast = (await response.json()) as Forecast
  log.success(
    `Forecast for ${city}: ${forecast.temperature_c}°C, ${forecast.condition}, ` +
      `wind ${forecast.wind_kmh} km/h, fresh snow ${forecast.fresh_snow_cm} cm, ` +
      `visibility ${forecast.visibility_km} km`,
  )
  log.info(`  Premium advice: ${forecast.premium_advice}`)
  return { city, pricePaidRlusd: price, txHash, forecast }
}

async function main() {
  log.box(['XRPL MPP -- Weather API client (pay per call in real testnet RLUSD)'])
  log.separator()

  const wallet = loadPayer()
  log.wallet('Payer (from PAYER_SEED)', wallet.address)
  log.separator()

  log.loading(`Discovering API at ${BASE}/info ...`)
  const info = await fetchInfo()
  const display = info.currencyDisplay
  log.wallet('API recipient (revenue)', info.recipient)
  log.info(
    `Currency: ${display} (issuer ${info.currency.issuer.slice(0, 6)}...${info.currency.issuer.slice(-4)})`,
  )
  log.info(`Price per /forecast call: ${info.pricePerCallRlusd} ${display}`)
  log.info(`Known cities: ${info.knownCities.join(', ')}`)
  log.separator()

  // TrustSet from the payer toward the RLUSD issuer. Idempotent: if the
  // payer already has a trustline at this limit (the common case when
  // reusing a wallet that already holds RLUSD), this is a no-op.
  log.loading(
    `Confirming trustline: payer accepts up to ${info.payerTrustlineLimitRlusd} ${display}...`,
  )
  const accept = await wallet.acceptToken(info.currency, {
    network: NETWORK,
    limit: info.payerTrustlineLimitRlusd,
  })
  if ('hash' in accept && accept.hash) {
    log.tx(accept.hash, log.explorerLink(accept.hash))
  }
  log.success(`Trustline status: ${accept.status}`)

  // Sanity-check the RLUSD balance before we attempt any paid call.
  // Without this the very first 402 would fail with INSUFFICIENT_IOU_BALANCE
  // and the diagnostic would be buried in mppx's error path.
  const holding = await wallet.holdsToken(info.currency, { network: NETWORK })
  const balance = holding && 'balance' in holding ? holding.balance : '0'
  log.info(`Payer ${display} balance: ${balance}`)
  if (Number(balance) <= 0) {
    log.error(`Payer holds 0 ${display} -- cannot run paid calls.`)
    log.info('Get testnet RLUSD from https://tryrlusd.com and re-run.')
    process.exit(1)
  }
  const requiredRlusd = Number(info.pricePerCallRlusd) * CITIES.length
  if (Number(balance) < requiredRlusd) {
    log.error(
      `Payer holds ${balance} ${display}, but ${requiredRlusd} ${display} ` +
        `is needed for ${CITIES.length} calls. Top up at https://tryrlusd.com and re-run.`,
    )
    process.exit(1)
  }
  log.separator()

  // Patch fetch so subsequent /forecast calls auto-handle the RLUSD 402.
  Mppx.create({
    methods: [charge({ wallet, mode: 'pull', network: NETWORK })],
  })

  log.box([
    'Querying the API',
    '',
    `Cities to fetch: ${CITIES.join(', ')}`,
    `Each call will cost ${info.pricePerCallRlusd} ${display} (one IOU Payment tx on XRPL).`,
  ])
  log.separator()

  const calls: CallRecord[] = []
  for (const city of CITIES) {
    const record = await getForecast(city, info.pricePerCallRlusd, display)
    calls.push(record)
    log.separator()
  }

  const successful = calls.filter((c) => !c.error)
  const totalSpent = successful.reduce((acc, c) => acc + Number(c.pricePaidRlusd), 0)

  // Re-read the on-chain balance so the settlement reflects reality
  // (the in-memory delta could disagree with the ledger if anything
  // off-script happened mid-run).
  const postHolding = await wallet.holdsToken(info.currency, { network: NETWORK })
  const remaining =
    postHolding && 'balance' in postHolding
      ? postHolding.balance
      : `~${Number(balance) - totalSpent}`

  const perCall = calls.map(
    (c, i) =>
      `  #${i + 1}  ${c.city.padEnd(14)}  ${c.pricePaidRlusd} ${display}  ` +
      (c.txHash ? `tx ${c.txHash.slice(0, 12)}...` : c.error ? `error: ${c.error}` : 'no tx'),
  )

  log.box([
    'Settlement -- weather-api-rlusd (RLUSD charge)',
    '',
    `Currency:                ${display} ` +
      `(issuer ${info.currency.issuer.slice(0, 6)}..., real testnet RLUSD)`,
    `Calls made:              ${calls.length} (${successful.length} succeeded)`,
    `Per-call price:          ${info.pricePerCallRlusd} ${display}`,
    '',
    'Per-call breakdown:',
    ...perCall,
    '',
    `Total spent:             ${totalSpent} ${display}`,
    `Balance before:          ${balance} ${display}`,
    `Balance after (ledger):  ${remaining} ${display}`,
    '',
    `On-chain footprint:      ${successful.length} RLUSD Payment tx (one per API call, charge mode)`,
    `Setup footprint:         ${accept.status === 'unchanged' ? '0' : '1'} TrustSet (payer side)`,
    '',
    'No API key, no signup, no monthly bill -- the request itself carries',
    'the payment, denominated in a real USD-pegged stablecoin.',
  ])

  process.exit(0)
}

main().catch((err) => {
  log.error(`Fatal: ${err.message}`)
  process.exit(1)
})
