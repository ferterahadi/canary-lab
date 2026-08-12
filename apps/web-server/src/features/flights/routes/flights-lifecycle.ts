// Flights REST — checkpoint answers and the pause/resume/autopilot/redo/delete
// lifecycle. Split out of flights.ts; handler bodies are unchanged.
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { FastifyInstance } from 'fastify'
import type { FlightRouteDeps } from './flight-route-deps'
import type { FlightRouteContext } from './flight-route-context'
import { FlightNotParkedError, FlightStageEntryError, resumeFlight, setFlightAutopilot, respondToFlightCheckpoint, pauseFlight, redoFlight, deleteFlight } from '../logic/conductor'
import { type FlightCheckpointResponse, type FlightStageKey } from '../logic/types'

export async function registerFlightLifecycleRoutes(app: FastifyInstance, deps: FlightRouteDeps, ctx: FlightRouteContext): Promise<void> {
  const { store, planStore, conductorDeps } = ctx

  app.post<{ Params: { id: string }; Body: { response?: FlightCheckpointResponse } | undefined }>(
    '/api/flights/:id/respond',
    async (req, reply) => {
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
        const message = err instanceof Error ? err.message : String(err)
        reply.code(message.includes('not found') ? 404 : 409)
        return { error: message }
      }
    },
  )

  app.post<{ Params: { id: string } }>('/api/flights/:id/resume', async (req, reply) => {
    try {
      const { manifest } = resumeFlight(req.params.id, conductorDeps)
      return manifest
    } catch (err) {
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
      try {
        const { manifest } = redoFlight(req.params.id, conductorDeps, {
          fromStage: req.body?.fromStage as FlightStageKey | undefined,
          feedback: req.body?.feedback,
        })
        reply.code(201)
        return manifest
      } catch (err) {
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
