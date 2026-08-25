// Flights REST — checkpoint answers and the pause/resume/autopilot/redo/delete
// lifecycle. Split out of flights.ts; handler bodies are unchanged.
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { FastifyInstance } from 'fastify'
import type { FlightRouteDeps } from './flight-route-deps'
import type { FlightRouteContext } from './flight-route-context'
import { FlightNotParkedError, FlightStageEntryError, FlightTakeoverRequestedError, forceFlightTakeover, requestFlightTakeover, resumeFlight, setFlightAutopilot, respondToFlightCheckpoint, pauseFlight, redoFlight, deleteFlight } from '../logic/conductor'
import { rejectForeignFlightDecision } from './flight-decision-origin'
import { reclaimGettingStartedFlight } from './flight-route-support'
import { GettingStartedBusyError } from '../../config/logic/getting-started-session'
import { type FlightCheckpointResponse, type FlightStageKey } from '../logic/types'

export async function registerFlightLifecycleRoutes(app: FastifyInstance, deps: FlightRouteDeps, ctx: FlightRouteContext): Promise<void> {
  const { store, planStore, conductorDeps } = ctx

  app.post<{ Params: { id: string }; Body: { response?: FlightCheckpointResponse } | undefined }>(
    '/api/flights/:id/respond',
    async (req, reply) => {
      const foreign = rejectForeignFlightDecision(req, reply, () => store.get(req.params.id))
      if (foreign) return foreign
      const response = req.body?.response
      if (!response || typeof response !== 'object') {
        reply.code(400)
        return { error: 'response is required' }
      }
      try {
        const { manifest } = respondToFlightCheckpoint(req.params.id, response, conductorDeps)
        return manifest
      } catch (err) {
        // A typed body, not just a message: this is the one rejection whose
        // recipient may be an agent that has just spent minutes on work nobody
        // wants any more. `type` lets it branch without parsing prose, and
        // `status`/`pauseReason` tell it whether the flight is resumable or done.
        if (err instanceof FlightNotParkedError) {
          reply.code(409)
          return {
            error: err.message,
            type: 'flight_not_parked',
            status: err.status,
            ...(err.pauseReason ? { pauseReason: err.pauseReason } : {}),
          }
        }
        if (err instanceof FlightTakeoverRequestedError) {
          reply.code(409)
          return {
            error: err.message,
            type: 'flight_takeover_requested',
            requestedAt: err.requestedAt,
          }
        }
        const message = err instanceof Error ? err.message : String(err)
        reply.code(message.includes('not found') ? 404 : 409)
        return { error: message }
      }
    },
  )

  // Cooperative external → internal hand-off. Request only records the user's
  // intent and makes later submits fail closed; Canary starts no local work
  // until the external client acknowledges with `run-internally`.
  app.post<{ Params: { id: string } }>('/api/flights/:id/takeover/request', async (req, reply) => {
    try {
      return requestFlightTakeover(req.params.id, conductorDeps)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      reply.code(message.includes('not found') ? 404 : 409)
      return { error: message, type: 'flight_takeover_unavailable' }
    }
  })

  // The external client cannot be interrupted between MCP calls. Force is an
  // explicit escape hatch only after a cooperative request, with a literal
  // confirmation in the body so a stray POST cannot create two file writers.
  app.post<{ Params: { id: string }; Body: { confirm?: boolean } | undefined }>(
    '/api/flights/:id/takeover/force',
    async (req, reply) => {
      if (req.body?.confirm !== true) {
        reply.code(400)
        return { error: 'confirm must be true' }
      }
      try {
        const { manifest } = forceFlightTakeover(req.params.id, conductorDeps)
        return manifest
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        reply.code(message.includes('not found') ? 404 : 409)
        return { error: message, type: 'flight_takeover_unavailable' }
      }
    },
  )

  app.post<{ Params: { id: string } }>('/api/flights/:id/resume', async (req, reply) => {
    const foreign = rejectForeignFlightDecision(req, reply, () => store.get(req.params.id))
    if (foreign) return foreign
    // Re-claim the Getting Started session (see reclaimGettingStartedFlight).
    // repoPaths ride along so a de-conflicted feature name (flight-app-2) still
    // matches on the repo basename.
    let gettingStartedSession: string | null = null
    try {
      const record = store.get(req.params.id)
      if (record) {
        gettingStartedSession = reclaimGettingStartedFlight(
          deps.gettingStarted, req.headers,
          { feature: record.feature, repoPaths: record.repoPaths }, req.params.id,
        )
      }
      const { manifest } = resumeFlight(req.params.id, conductorDeps)
      if (gettingStartedSession) {
        deps.gettingStarted?.attach(gettingStartedSession, { kind: 'flight', id: manifest.flightId })
      }
      return manifest
    } catch (err) {
      if (gettingStartedSession) deps.gettingStarted?.abandon(gettingStartedSession)
      if (err instanceof GettingStartedBusyError) {
        reply.code(409)
        return { type: err.type, error: err.message, active: err.active }
      }
      const message = err instanceof Error ? err.message : String(err)
      reply.code(message.includes('not found') ? 404 : 409)
      return { error: message }
    }
  })

  // User-initiated pause: parks the flight resumable and stops the in-flight
  // stage work — a spawned agent, a run, a portify workflow, an export. The
  // response is deliberately held until that teardown finishes, so a 200 here
  // means the work is stopped rather than merely signalled. See the run adapter's
  // teardown note for why pause ends its run too.
  app.post<{ Params: { id: string } }>('/api/flights/:id/pause', async (req, reply) => {
    const foreign = rejectForeignFlightDecision(req, reply, () => store.get(req.params.id))
    if (foreign) return foreign
    try {
      return await pauseFlight(req.params.id, conductorDeps)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      reply.code(message.includes('not found') ? 404 : 409)
      return { error: message }
    }
  })

  // R78: autopilot is a live preference, not a start-time-only option — flip it
  // on any flight, in any status. Takes effect at the NEXT checkpoint (the drive
  // re-reads opts); a checkpoint already parked stays parked for the human.
  app.post<{ Params: { id: string }; Body: { autopilot?: boolean } | undefined }>(
    '/api/flights/:id/autopilot',
    async (req, reply) => {
      const foreign = rejectForeignFlightDecision(req, reply, () => store.get(req.params.id))
      if (foreign) return foreign
      if (typeof req.body?.autopilot !== 'boolean') {
        reply.code(400)
        return { error: 'autopilot must be a boolean' }
      }
      try {
        return setFlightAutopilot(req.params.id, req.body.autopilot, conductorDeps)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        reply.code(message.includes('not found') ? 404 : 409)
        return { error: message }
      }
    },
  )

  // Re-fly this record using its own stored intent/repos/options (no
  // client-side body reconstruction). No body → from stage 1 ("start over");
  // fromStage → Continue → "from a step…", with the optional "what went wrong"
  // note scoped to that stage's agent prompt (R74).
  app.post<{ Params: { id: string }; Body: { fromStage?: string; feedback?: string } | undefined }>(
    '/api/flights/:id/redo',
    async (req, reply) => {
      const foreign = rejectForeignFlightDecision(req, reply, () => store.get(req.params.id))
      if (foreign) return foreign
      // Redo sets a settled demo flight moving again exactly like resume does,
      // so it re-claims the Getting Started session the same way — without
      // this a "Start over" ran the demo untracked.
      let gettingStartedSession: string | null = null
      try {
        const record = store.get(req.params.id)
        if (record) {
          gettingStartedSession = reclaimGettingStartedFlight(
            deps.gettingStarted, req.headers,
            { feature: record.feature, repoPaths: record.repoPaths }, req.params.id,
          )
        }
        const { manifest } = redoFlight(req.params.id, conductorDeps, {
          fromStage: req.body?.fromStage as FlightStageKey | undefined,
          feedback: req.body?.feedback,
        })
        if (gettingStartedSession) {
          deps.gettingStarted?.attach(gettingStartedSession, { kind: 'flight', id: manifest.flightId })
        }
        reply.code(201)
        return manifest
      } catch (err) {
        if (gettingStartedSession) deps.gettingStarted?.abandon(gettingStartedSession)
        if (err instanceof GettingStartedBusyError) {
          reply.code(409)
          return { type: err.type, error: err.message, active: err.active }
        }
        if (err instanceof FlightStageEntryError) {
          reply.code(400)
          return { error: err.message, type: 'stage_entry_rejected' }
        }
        const message = err instanceof Error ? err.message : String(err)
        reply.code(message.includes('not found') ? 404 : 409)
        return { error: message }
      }
    },
  )

  // Delete a NON-ACTIVE flight record — the frozen-repos escape hatch. The
  // feature and its on-disk artifacts stay; the pill row returns to "not
  // flown" so a fresh start can pick new repos/intent.
  app.delete<{ Params: { id: string } }>('/api/flights/:id', async (req, reply) => {
    try {
      deleteFlight(req.params.id, conductorDeps)
      return { deleted: true }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      reply.code(message.includes('not found') ? 404 : 409)
      return { error: message }
    }
  })

  // ---- Plan features (pre-flight intent breakdown) ------------------------
  // The new-flight dialog's "Plan flight" step: an agent judges whether the
  // intent describes one feature or several, the user confirms the proposal,
  // and launch creates one flight per feature — the first running, the rest
  // parked `queued` for the conductor's sequential drain.
}
