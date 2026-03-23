import type { Method } from 'mppx'
import type { ChannelClientConfig } from '../../types.js'
import type { channel as channelMethod } from '../Methods.js'

/** Client-side XRPL channel method configuration. */
export type Parameters = ChannelClientConfig

/** Create a client-side XRPL channel method. Implemented in Phase 2. */
export function channel(_parameters: Parameters): Method.Client<typeof channelMethod> {
  throw new Error('Not implemented -- Phase 2')
}

export declare namespace channel {
  export type Parameters = ChannelClientConfig
}

/** Open a new PayChannel on-chain. Implemented in Phase 2. */
export function openChannel(_params: {
  seed: string
  destination: string
  amount: string
  settleDelay: number
  network?: string
  rpcUrl?: string
}): Promise<{ channelId: string; txHash: string }> {
  throw new Error('Not implemented -- Phase 2')
}

/** Fund an existing PayChannel. Implemented in Phase 2. */
export function fundChannel(_params: {
  seed: string
  channelId: string
  amount: string
  network?: string
  rpcUrl?: string
}): Promise<{ txHash: string }> {
  throw new Error('Not implemented -- Phase 2')
}
