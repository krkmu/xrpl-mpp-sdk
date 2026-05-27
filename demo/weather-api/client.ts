/**
 * Weather API (IOU charge) -- Client
 *
 * A consumer of a premium weather API that, instead of an API key or
 * monthly subscription, bills every call as an on-chain micropayment in
 * the API's own token (`WTH`). The whole pitch in one paragraph:
 *
 *   Traditional SaaS API:   Authorization: Bearer sk-... + invoice end of month
 *   This API:               HTTP 402 -> 1 WTH on-chain -> 200 + forecast
 *
 * Bootstrap (one-time, before any paid call):
 *   1. Fund a fresh wallet via the XRPL testnet faucet (XRP for the
 *      trustline reserve and tx fees -- not what we're paying *with*).
 *   2. GET /info to discover marketplace address, currency, and pricing.
 *   3. Open a trustline to the issuer (acceptToken / TrustSet) so the
 *      payer can hold and spend WTH.
 *   4. POST /faucet-iou to receive the demo allowance (10 WTH).
 *      Demo-only bootstrap; in production this would be a paid top-up
 *      (card payment, DEX swap, fiat on-ramp, ...).
 *
 * Then for each city in CITIES we POST /forecast. mppx intercepts the
 * 402, signs an IOU `Payment` for 1 WTH, submits to XRPL, polls until
 * validated, and retries the request transparently. The settlement
 * summary at the end shows per-call tx hashes and total WTH spent.
 *
 * Run: npx tsx demo/weather-api/client.ts
 *      (after `npx tsx demo/weather-api/server.ts`)
 */
import { Receipt } from 'mppx'
import { Mppx } from 'mppx/client'
import { charge } from '../../sdk/src/client/Charge.js'
import { Wallet } from '../../sdk/src/utils/wallet.js'
import * as log from '../log.js'

const PORT = 3007
const BASE = `http://localhost:${PORT}`
const NETWORK = 'testnet' as const

const rawFetch = globalThis.fetch

/**
 * The cities to query. Edit this list to exercise more or fewer paid
 * calls. The server only knows about its built-in `KNOWN_CITIES`; any
 * other name will still bill and return a deterministic mock forecast.
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
  issuer: string
  recipient: string
  network: string
  currency: { currency: string; issuer: string }
  pricePerCallWth: string
  faucetAllowanceWth: string
  payerTrustlineLimitWth: string
  knownCities: string[]
}

type CallRecord = {
  city: string
  pricePaidWth: string
  txHash: string
  forecast: Forecast | null
  error?: string
}

async function fetchInfo(): Promise<Info> {
  const res = await rawFetch(`${BASE}/info`)
  if (!res.ok) throw new Error(`/info failed: ${res.status}`)
  return (await res.json()) as Info
}

async function fetchFaucetIou(holder: string): Promise<{ txHash: string }> {
  const res = await rawFetch(`${BASE}/faucet-iou`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ holder }),
  })
  if (!res.ok) throw new Error(`/faucet-iou failed: ${res.status} ${await res.text()}`)
  const json = (await res.json()) as { txHash: string }
  return { txHash: json.txHash }
}

/**
 * Call /forecast for a single city. mppx intercepts the 402 silently:
 * reads the WTH challenge, signs an IOU Payment, submits to XRPL, retries
 * the request once the tx is validated. From the caller's point of view
 * this is just an HTTP request that takes ~one ledger close to settle.
 */
async function getForecast(city: string, price: string): Promise<CallRecord> {
  log.loading(`GET forecast("${city}") -- mppx will auto-pay ${price} WTH...`)
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
      pricePaidWth: '0',
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
  return { city, pricePaidWth: price, txHash, forecast }
}

async function main() {
  log.box(['XRPL MPP -- Weather API client (no API key, pay per call in WTH)'])
  log.separator()

  log.loading('Funding payer wallet via testnet faucet...')
  const wallet = await Wallet.fromFaucet({ network: NETWORK })
  log.wallet('Payer', wallet.address)
  log.separator()

  log.loading(`Discovering API at ${BASE}/info ...`)
  const info = await fetchInfo()
  log.wallet('API issuer (treasury)', info.issuer)
  log.wallet('API recipient (revenue)', info.recipient)
  log.info(
    `Currency: ${info.currency.currency} (issuer ${info.currency.issuer.slice(0, 6)}...${info.currency.issuer.slice(-4)})`,
  )
  log.info(`Price per /forecast call: ${info.pricePerCallWth} ${info.currency.currency}`)
  log.info(`Known cities: ${info.knownCities.join(', ')}`)
  log.separator()

  // TrustSet from the payer toward the issuer. Without this the payer
  // cannot hold or transfer WTH, and the very first 402 fails at
  // preflight with PAYMENT_PATH_FAILED.
  log.loading(
    `Opening trustline: payer accepts up to ${info.payerTrustlineLimitWth} ${info.currency.currency}...`,
  )
  const accept = await wallet.acceptToken(info.currency, {
    network: NETWORK,
    limit: info.payerTrustlineLimitWth,
  })
  if ('hash' in accept && accept.hash) {
    log.tx(accept.hash, log.explorerLink(accept.hash))
  }
  log.success(`Trustline status: ${accept.status}`)
  log.separator()

  log.loading(
    `Requesting demo allowance from /faucet-iou (${info.faucetAllowanceWth} ${info.currency.currency})...`,
  )
  const faucetIou = await fetchFaucetIou(wallet.address)
  log.tx(faucetIou.txHash, log.explorerLink(faucetIou.txHash))
  log.success(`Payer credited with ${info.faucetAllowanceWth} ${info.currency.currency}`)
  log.separator()

  // Patch fetch so subsequent /forecast calls auto-handle the WTH 402.
  Mppx.create({
    methods: [charge({ wallet, mode: 'pull', network: NETWORK })],
  })

  log.box([
    'Querying the API',
    '',
    `Cities to fetch: ${CITIES.join(', ')}`,
    `Each call will cost ${info.pricePerCallWth} ${info.currency.currency} (one IOU Payment tx on XRPL).`,
  ])
  log.separator()

  const calls: CallRecord[] = []
  for (const city of CITIES) {
    const record = await getForecast(city, info.pricePerCallWth)
    calls.push(record)
    log.separator()
  }

  const successful = calls.filter((c) => !c.error)
  const totalSpent = successful.reduce((acc, c) => acc + Number(c.pricePaidWth), 0)
  const remaining = Number(info.faucetAllowanceWth) - totalSpent

  const perCall = calls.map(
    (c, i) =>
      `  #${i + 1}  ${c.city.padEnd(14)}  ${c.pricePaidWth} ${info.currency.currency}  ` +
      (c.txHash ? `tx ${c.txHash.slice(0, 12)}...` : c.error ? `error: ${c.error}` : 'no tx'),
  )

  log.box([
    'Settlement -- weather-api (IOU charge)',
    '',
    `Currency:                ${info.currency.currency} (issuer ${info.currency.issuer.slice(0, 6)}...)`,
    `Calls made:              ${calls.length} (${successful.length} succeeded)`,
    `Per-call IOU price:      ${info.pricePerCallWth} ${info.currency.currency}`,
    '',
    'Per-call breakdown:',
    ...perCall,
    '',
    `Total spent:             ${totalSpent} ${info.currency.currency}`,
    `Initial allowance:       ${info.faucetAllowanceWth} ${info.currency.currency}`,
    `Remaining balance:       ${remaining} ${info.currency.currency}`,
    '',
    `On-chain footprint:      ${successful.length} IOU Payment tx (one per API call, charge mode)`,
    'Setup footprint (once):  1 TrustSet (payer) + 1 issuance (API -> payer)',
    '',
    'No API key, no signup, no monthly bill -- the request itself carries',
    'the payment and the receipt arrives in the response headers.',
  ])

  process.exit(0)
}

main().catch((err) => {
  log.error(`Fatal: ${err.message}`)
  process.exit(1)
})
