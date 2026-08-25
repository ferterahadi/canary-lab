// Who is allowed to decide for an externally driven flight.
//
// `stageProducer: 'external'` (the default for any flight started over MCP)
// means the client that started the flight does the thinking — it authors the
// scout config, gathers the docs, writes the specs, drives portify and the
// repair loop — and answers its own checkpoints. The web UI is a VIEWER of that
// flight, not a second driver: a Respond → click from the browser answers a
// question the agent is mid-way through answering, and the two results race.
//
// Hiding the buttons is not enough to make that true. The MCP tools do not have
// a private API — `flightsRequest` injects into the SAME `/api/flights/:id/...`
// routes the browser posts to (see server.ts), so from a route's point of view
// the agent and the UI are indistinguishable. This module is what tells them
// apart: the MCP injection stamps `MCP_ORIGIN_HEADER`, and a decision route
// refuses anything without it while the flight is externally driven and live.
//
// Deliberately NOT covered, because none answers work on the agent's behalf:
// `/abort` ends a flight whose client has gone away; `/remedy` changes the
// user's own dirty repos; takeover request/force is the explicit ownership
// transfer protocol; DELETE is only reachable once the flight is settled.
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { FlightManifest } from '../logic/types'

/** Set by the MCP layer's `app.inject` (server.ts) and by nothing else — a
 *  browser cannot forge it into a same-origin fetch worth guarding against,
 *  and this is a local single-user server, so the header is an origin TAG
 *  rather than an authentication token. */
export const MCP_ORIGIN_HEADER = 'x-canary-origin'

/** A flight only reserves its decisions while there is still a driving client
 *  to make them. Once it settles, the agent is gone and the UI owns the record
 *  again — Fly again, Continue from a step, delete. */
function isLive(status: FlightManifest['status']): boolean {
  return status === 'running' || status === 'waiting-for-approval' || status === 'paused'
}

/** True when this flight's decisions belong to the MCP client that started it. */
export function isExternallyDriven(manifest: FlightManifest): boolean {
  return manifest.opts.stageProducer === 'external' && isLive(manifest.status)
}

/** Guard for the flight lifecycle routes that DECIDE something (respond, pause,
 *  resume, autopilot, redo). Returns a 409 body when the caller is the web UI
 *  and the flight is externally driven; `null` when the call may proceed.
 *
 *  409 rather than 403: nothing is wrong with the caller's credentials — the
 *  flight is simply in a state where this is not its call to make, which is the
 *  same conflict shape the other flight routes already return. */
export function rejectForeignFlightDecision(
  req: FastifyRequest,
  reply: FastifyReply,
  readManifest: () => FlightManifest | null,
): { error: string; type: 'flight_externally_driven' } | null {
  // A lookup that throws (or a flight that isn't there) is not evidence the
  // flight is externally driven, so the guard declines rather than inventing a
  // 500 in front of a handler that already has a correct answer for both — the
  // 404 for a missing flight, the 409 for a broken store.
  const manifest = (() => { try { return readManifest() } catch { return null } })()
  if (!manifest || !isExternallyDriven(manifest)) return null
  if (req.headers[MCP_ORIGIN_HEADER] === 'mcp') return null
  reply.code(409)
  return {
    error:
      'This flight is being driven by the agent that started it — answer its checkpoints, pause it, and resume it from there. '
      + 'This UI keeps Abort, and an external-work step also offers Request takeover for a safe transfer back to Canary Lab.',
    type: 'flight_externally_driven',
  }
}
