import type { Method } from 'mppx'
import type { charge as chargeMethod } from '../Methods.js'
import type { ChargeServerConfig } from '../types.js'

/** Server-side XRPL charge method configuration. */
export type Parameters = ChargeServerConfig

/** Create a server-side XRPL charge method. Implemented in Phase 1. */
export function charge(_parameters: Parameters): Method.Server<typeof chargeMethod> {
  throw new Error('Not implemented -- Phase 1')
}

export declare namespace charge {
  export type Parameters = ChargeServerConfig
}
