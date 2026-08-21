import { registerFlightTools } from '../flight'
import type { McpClientFacts } from '../../client-surface'
import { captureTools, DEFAULT_CLIENT_FACTS, type CapturedTools } from './tool-group-harness'

// Drives the flight tool group without a server: capture the handlers
// `registerFlightTools` registers, then call them directly against a fake
// `flightsRequest`. Faster and far more controllable than an MCP client over
// HTTP, and it is the REPLY shape these tools branch on — not the transport.
//
// One harness rather than a copy per test file: `reply` takes either a single
// canned answer or a router, which is what the ad-hoc variants differed by.
// The handler capture itself is shared with every other group via captureTools;
// what belongs here is the `flightsRequest` fake and the flight body shapes.

export interface FlightRequest {
  method: string
  url: string
  payload?: unknown
}

export interface FlightReply {
  statusCode: number
  body: unknown
}

export interface FlightHarnessOpts {
  /** A single reply for every request, a router keyed on the request, or a
   *  thrower — anything the tools must survive. */
  reply: FlightReply | ((req: FlightRequest) => FlightReply | Promise<FlightReply>)
  /** Omit `flightsRequest` entirely, to reach the not-configured guards. */
  unavailable?: boolean
  /** What this session's client can do; drives the fan-out advice. */
  clientFacts?: McpClientFacts
}

export interface FlightHarness extends CapturedTools {
  /** Every request the tools made, in order. */
  requests: FlightRequest[]
}

export function flightHarness(opts: FlightHarnessOpts): FlightHarness {
  const requests: FlightRequest[] = []
  const flightsRequest = async (req: FlightRequest): Promise<FlightReply> => {
    requests.push(req)
    return typeof opts.reply === 'function' ? opts.reply(req) : opts.reply
  }
  const captured = captureTools(
    registerFlightTools,
    opts.unavailable ? {} : { flightsRequest },
    opts.clientFacts ?? DEFAULT_CLIENT_FACTS,
  )
  return { ...captured, requests }
}

/** A flight parked on an `external-work` hand-off — the shape the stand-down and
 *  steering assertions are built on. */
export function parkedFlight(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    flightId: 'fl-1',
    feature: 'checkout',
    status: 'waiting-for-approval',
    currentStage: 'scout',
    stages: [{
      key: 'scout',
      status: 'waiting-for-approval',
      checkpoint: {
        kind: 'external-work',
        message: 'do the scout step',
        options: ['submit', 'run-internally'],
        data: { stage: 'scout', prompt: 'survey the repo', handOffId: 'abc12345' },
      },
    }],
    ...over,
  }
}

/** A flight parked on an arbitrary checkpoint kind, for the steering copy. */
export function parkedOn(kind: string, data?: unknown, options: string[] = ['approve', 'redraft']): Record<string, unknown> {
  return {
    flightId: 'fl-1',
    feature: 'checkout',
    status: 'waiting-for-approval',
    currentStage: 'docs',
    stages: [{
      key: 'docs',
      status: 'waiting-for-approval',
      checkpoint: { kind, message: `answer the ${kind} checkpoint`, options, ...(data !== undefined ? { data } : {}) },
    }],
  }
}

/** A settled or running flight with no open checkpoint. */
export function plainFlight(status: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return { flightId: 'fl-1', feature: 'checkout', status, currentStage: null, stages: [], ...over }
}
