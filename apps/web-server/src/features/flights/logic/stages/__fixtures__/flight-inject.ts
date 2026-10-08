import type { FlightInject } from '../context'

export type FlightInjectCall = { method: string; url: string; payload?: unknown }

export type FlightInjectImpl = (call: FlightInjectCall) => { statusCode: number; body: unknown } | undefined

/** The in-process HTTP seam a stage calls its own server through. Every call is
 *  recorded in `calls`; a request `impl` does not answer gets a 500 naming it,
 *  so a stage reaching an endpoint the suite did not stub fails loudly instead
 *  of reading a plausible empty body. */
export function fakeFlightInject(impl: FlightInjectImpl, calls: FlightInjectCall[] = []): FlightInject {
  return async (opts) => {
    calls.push(opts)
    const out = impl(opts) ?? { statusCode: 500, body: { error: `unstubbed ${opts.method} ${opts.url}` } }
    return { statusCode: out.statusCode, json: () => out.body }
  }
}
