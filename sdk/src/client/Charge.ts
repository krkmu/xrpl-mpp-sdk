import type { Method } from 'mppx'
import type { charge as chargeMethod } from '../Methods.js'
import type { ChargeClientConfig } from '../types.js'

/** Client-side XRPL charge method configuration. */
export type Parameters = ChargeClientConfig

/** Create a client-side XRPL charge method. Implemented in Phase 1. */
export function charge(_parameters: Parameters): Method.Client<typeof chargeMethod> {
  throw new Error('Not implemented -- Phase 1')
}

export declare namespace charge {
  export type Parameters = ChargeClientConfig
}
