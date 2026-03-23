/**
 * Example: Channel client with off-chain claims.
 *
 * Run: npx tsx examples/client-channel.ts
 */
import { Mppx } from 'mppx/client'
import { channel } from '../sdk/src/channel/client/Channel.js'

const channelMethod = channel({
  seed: 'sEdVYOURSEEDHERE', // Replace with your testnet seed
  network: 'testnet',
})

const _mppx = Mppx.create({
  methods: [channelMethod],
})

// Fetching a protected resource signs off-chain claims:
// const response = await mppx.fetch('https://api.example.com/resource')

console.log('Client channel example -- see demo/ for runnable versions.')
