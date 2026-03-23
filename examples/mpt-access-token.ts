/**
 * Example: MPT-based API access token.
 *
 * This example shows how to use MPT payments for API access.
 * The server requires payment in a specific MPT to grant access.
 *
 * Run: npx tsx examples/mpt-access-token.ts
 */
import { charge } from '../sdk/src/client/Charge.js'
import { charge as serverCharge } from '../sdk/src/server/Charge.js'

// Client configuration -- pays with MPT
const _clientMethod = charge({
  seed: 'sEdVYOURSEEDHERE', // Replace with your testnet seed
  mode: 'pull',
  autoMPTAuthorize: true, // Auto-authorize MPT holding if needed
  preflight: true,
  network: 'testnet',
})

// Server configuration -- accepts MPT payment
const _serverMethod = serverCharge({
  recipient: 'rN7bRFgBrNZKoY2uu015bdjah11UbRZY', // Replace with your address
  currency: {
    mpt_issuance_id: '00000001A407AF5856CEFB379FAE300376E06FCEEDDC455BE0',
  },
  network: 'testnet',
})

console.log('MPT access token example.')
console.log('The server requires payment of a specific MPT to grant API access.')
console.log('The client auto-authorizes the MPT holding if needed.')
console.log('See demo/ for runnable versions.')
