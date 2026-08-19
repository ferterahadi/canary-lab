// Flights REST — starting a flight and the plan-features task surface.
// Split out of flights.ts; handler bodies are unchanged.
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { FastifyInstance } from 'fastify'
import type { FlightRouteDeps } from './flight-route-deps'
import type { FlightRouteContext } from './flight-route-context'
import { FlightConflictError, FlightExistsError, FlightFrozenError, FlightStageEntryError, startFlight, type FlightEntryMode } from '../logic/conductor'
import { FLIGHT_STAGE_KEYS, type FlightOptions, type FlightStageKey } from '../logic/types'
import { expandHome } from './flight-route-support'
import { GettingStartedBusyError, type GettingStartedOwner } from '../../config/logic/getting-started-session'

export async function registerFlightStartRoutes(app: FastifyInstance, deps: FlightRouteDeps, ctx: FlightRouteContext): Promise<void> {
  const { store, planStore, conductorDeps } = ctx

  app.post<{
    Body:
      | {
          feature?: string
          repoPaths?: string[]
          description?: string
          env?: string
          coverageTarget?: number
          base?: string
          yolo?: boolean
          /** Absent = on; only an explicit false opts out (R71/W4). */
          autopilot?: boolean
          /** R79: which CLI conducts the flight's stage agents; sticky per
           *  record (jump/continue reuse the stored one). Absent → claude. */
          agent?: string
          /** Who executes the hand-off-capable stages (scout, docs,
           *  specs-coverage): the local CLI, or the MCP client driving the
           *  flight. Sticky per record. Absent → internal. A GUI start never
           *  sends it — there is no MCP client to hand work to. */
          stageProducer?: string
          /** continue | redo | jump — required when the feature already has a
           *  flight record (409 flight_exists_requires_choice otherwise). */
          mode?: string
          /** Stage to start at (jump / fresh stage entry), prereq-validated. */
          fromStage?: string
          gettingStartedSource?: GettingStartedOwner
        }
      | undefined
  }>('/api/flights', async (req, reply) => {
    const body = req.body ?? {}
    if (body.mode !== undefined && !['continue', 'redo', 'jump'].includes(body.mode)) {
      reply.code(400)
      return { error: `invalid mode: ${body.mode} (expected continue | redo | jump)` }
    }
    if (
      body.fromStage !== undefined &&
      !(FLIGHT_STAGE_KEYS as readonly string[]).includes(body.fromStage)
    ) {
      reply.code(400)
      return { error: `invalid fromStage: ${body.fromStage} (expected one of ${FLIGHT_STAGE_KEYS.join(', ')})` }
    }
    // Repos + intent are frozen on the record, so a mode-carrying call
    // (continue / redo / jump) may omit them — the conductor reuses the stored
    // values. A fresh start still requires both.
    const hasMode = body.mode !== undefined
    const repoPaths = Array.isArray(body.repoPaths) ? body.repoPaths : []
    if (repoPaths.some((p) => typeof p !== 'string')) {
      reply.code(400)
      return { error: 'repoPaths must be a string array' }
    }
    if (!hasMode && repoPaths.length === 0) {
      reply.code(400)
      return { error: 'repoPaths (non-empty string array) is required' }
    }
    const description = typeof body.description === 'string' ? body.description.trim() : ''
    if (!hasMode && description === '') {
      reply.code(400)
      return { error: 'description is required' }
    }
    if (typeof body.feature !== 'string' || body.feature.trim() === '') {
      reply.code(400)
      return { error: 'feature is required' }
    }
    const coverageTarget = body.coverageTarget ?? 100
    if (typeof coverageTarget !== 'number' || coverageTarget < 0 || coverageTarget > 100) {
      reply.code(400)
      return { error: 'coverageTarget must be a number between 0 and 100' }
    }

    // Realpath the repo set: it is the single-flight key, so two spellings of
    // the same directory must collide, not slip past each other. Configs may
    // declare repos as `~/...` — expand like the entry prefill does.
    const resolved: string[] = []
    for (const p of repoPaths) {
      try {
        resolved.push(fs.realpathSync(path.resolve(expandHome(p))))
      } catch {
        reply.code(400)
        return { error: `repo path does not exist: ${p}` }
      }
    }

    const opts: FlightOptions = {
      env: body.env ?? 'local',
      coverageTarget,
      ...(body.base ? { base: body.base } : {}),
      yolo: body.yolo === true,
      ...(body.autopilot === false ? { autopilot: false } : {}),
      ...(body.agent === 'claude' || body.agent === 'codex' ? { agent: body.agent } : {}),
      // Unknown values are dropped rather than rejected, matching `agent` above:
      // an older client sending nonsense degrades to the internal default instead
      // of failing a flight start.
      ...(body.stageProducer === 'internal' || body.stageProducer === 'external' ? { stageProducer: body.stageProducer } : {}),
    }

    let gettingStartedSession: string | null = null
    if (body.gettingStartedSource && deps.gettingStarted) {
      try {
        gettingStartedSession = deps.gettingStarted.claim('flight', body.gettingStartedSource).sessionId
      } catch (err) {
        if (!(err instanceof GettingStartedBusyError)) throw err
        reply.code(409)
        return { type: err.type, error: err.message, active: err.active }
      }
    }

    try {
      const { manifest } = startFlight(
        {
          feature: body.feature.trim(),
          repoPaths: resolved,
          description,
          opts,
          ...(body.mode ? { mode: body.mode as FlightEntryMode } : {}),
          ...(body.fromStage ? { fromStage: body.fromStage as FlightStageKey } : {}),
        },
        conductorDeps,
      )
      if (gettingStartedSession) {
        deps.gettingStarted?.attach(gettingStartedSession, { kind: 'flight', id: manifest.flightId })
      }
      reply.code(201)
      return manifest
    } catch (err) {
      if (gettingStartedSession) deps.gettingStarted?.abandon(gettingStartedSession)
      if (err instanceof FlightConflictError) {
        reply.code(409)
        return { error: err.message, type: 'flight_conflict', existingFlightId: err.existingFlightId }
      }
      if (err instanceof FlightExistsError) {
        reply.code(409)
        return {
          error: err.message,
          type: 'flight_exists_requires_choice',
          existingFlightId: err.existingFlightId,
          existingStatus: err.existingStatus,
          options: err.options,
        }
      }
      if (err instanceof FlightFrozenError) {
        reply.code(409)
        return { error: err.message, type: 'flight_frozen' }
      }
      if (err instanceof FlightStageEntryError) {
        reply.code(400)
        return { error: err.message, type: 'stage_entry_rejected' }
      }
      throw err
    }
  })
}
