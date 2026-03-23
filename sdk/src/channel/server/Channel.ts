import type { Method } from 'mppx'
import type { ChannelServerConfig } from '../../types.js'
import type { channel as channelMethod } from '../Methods.js'

/** Server-side XRPL channel method configuration. */
export type Parameters = ChannelServerConfig

/** Create a server-side XRPL channel method. Implemented in Phase 2. */
export function channel(_parameters: Parameters): Method.Server<typeof channelMethod> {
  throw new Error('Not implemented -- Phase 2')
}

export declare namespace channel {
  export type Parameters = ChannelServerConfig
}

/** Close a PayChannel on-chain. Implemented in Phase 2. */
export function close(_params: {
  seed: string
  channelId: string
  amount: string
  signature: string
  network?: string
  rpcUrl?: string
}): Promise<{ txHash: string }> {
  throw new Error('Not implemented -- Phase 2')
}
