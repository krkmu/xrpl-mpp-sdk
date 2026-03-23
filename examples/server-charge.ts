/**
 * Example: Express/Hono-style server with XRP charge.
 *
 * Run: npx tsx examples/server-charge.ts
 */
import { Mppx, Store } from 'mppx/server'
import { charge } from '../sdk/src/server/Charge.js'

const store = Store.memory()

const chargeMethod = charge({
  recipient: 'rN7bRFgBrNZKoY2uu015bdjah11UbRZY', // Replace with your address
  network: 'testnet',
  store,
})

const _mppx = Mppx.create({
  methods: [chargeMethod],
  realm: 'example.com',
})

// Use with any HTTP framework:
// const handler = mppx['xrpl/charge']({ amount: '1000000', currency: 'XRP' })
// const result = await handler(request)
// if (result.response) return result.response
// return result.withReceipt(new Response('Paid content'))

console.log('Server charge example -- see demo/ for runnable versions.')
