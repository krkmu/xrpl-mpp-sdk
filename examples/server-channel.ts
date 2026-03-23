/**
 * Example: Channel-based server.
 *
 * Run: npx tsx examples/server-channel.ts
 */
import { Mppx, Store } from 'mppx/server'
import { channel } from '../sdk/src/channel/server/Channel.js'

const store = Store.memory()

const channelMethod = channel({
  publicKey: 'EDYOURPUBLICKEYHERE', // Replace with channel funder's public key
  network: 'testnet',
  store,
})

const _mppx = Mppx.create({
  methods: [channelMethod],
  realm: 'example.com',
})

// Use with any HTTP framework:
// const handler = mppx['xrpl/channel']({ amount: '100000', channelId: '...', recipient: '...' })

console.log('Server channel example -- see demo/ for runnable versions.')
