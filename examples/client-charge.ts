/**
 * Example: Agent client with auto-trustline.
 *
 * Run: npx tsx examples/client-charge.ts
 */
import { Mppx } from 'mppx/client'
import { charge } from '../sdk/src/client/Charge.js'

const chargeMethod = charge({
  seed: 'sEdVYOURSEEDHERE', // Replace with your testnet seed
  mode: 'pull',
  autoTrustline: true,
  autoMPTAuthorize: true,
  preflight: true,
  network: 'testnet',
})

const _mppx = Mppx.create({
  methods: [chargeMethod],
})

// Fetching a protected resource automatically handles 402 challenges:
// const response = await mppx.fetch('https://api.example.com/resource')

console.log('Client charge example -- see demo/ for runnable versions.')
