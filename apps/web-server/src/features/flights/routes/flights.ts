import fs from 'fs'
import path from 'path'
import type { FastifyInstance } from 'fastify'
import {
  loadAgentSession,
  resolveWorkflowAgentRef,
} from '../../agent-sessions/logic/agent-session-log'
import { FlightRunStore, type FlightStore } from '../logic/store'
import {
  FlightConflictError,
  startFlight,
  resumeFlight,
  respondToFlightCheckpoint,
  abortFlight,
  type FlightConductorDeps,
  type StageAdapters,
} from '../logic/conductor'
import type { FlightCheckpointResponse, FlightOptions } from '../logic/types'
import type { WorkspaceEventPublisher } from '../../../shared/workspace-events'

export interface FlightRouteDeps {
  featuresDir: string
  logsDir: string
  projectRoot: string
  /** Stage adapters the conductor drives (Phase 3 builds the real set; tests
   *  inject stubs). */
  adapters: StageAdapters
  /** Shared store (so WS + restart-reconcile see the same instance). Omitted
   *  in tests → a fresh file-backed store over logsDir. */
  flightStore?: FlightStore
  workspaceEvents?: WorkspaceEventPublisher
}

// First Flight REST surface — the same store/conductor the MCP flight tools
// drive (dual-surface parity). Start is non-blocking: it validates input,
// creates the running manifest, kicks the conductor off detached, and returns
// 201 with the manifest; progress is read back via GET (UI/CLI poll or ride
// the `flights-changed` WorkspaceEvent).

export async function flightsRoutes(app: FastifyInstance, deps: FlightRouteDeps): Promise<void> {
  const store = deps.flightStore ?? new FlightRunStore(deps.logsDir)
  const conductorDeps: FlightConductorDeps = {
    store,
    adapters: deps.adapters,
    workspaceEvents: deps.workspaceEvents,
  }

  app.get('/api/flights', async () => ({ flights: store.list() }))

  app.get<{ Params: { id: string } }>('/api/flights/:id', async (req, reply) => {
    const manifest = store.get(req.params.id)
    if (!manifest) {
      reply.code(404)
      return { error: `flight not found: ${req.params.id}` }
    }
    return manifest
  })

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
        }
      | undefined
  }>('/api/flights', async (req, reply) => {
    const body = req.body ?? {}
    const repoPaths = Array.isArray(body.repoPaths) ? body.repoPaths : []
    if (repoPaths.length === 0 || repoPaths.some((p) => typeof p !== 'string')) {
      reply.code(400)
      return { error: 'repoPaths (non-empty string array) is required' }
    }
    if (typeof body.description !== 'string' || body.description.trim() === '') {
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
    // the same directory must collide, not slip past each other.
    const resolved: string[] = []
    for (const p of repoPaths) {
      try {
        resolved.push(fs.realpathSync(path.resolve(p)))
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
    }

    try {
      const { manifest } = startFlight(
        { feature: body.feature.trim(), repoPaths: resolved, description: body.description.trim(), opts },
        conductorDeps,
      )
      reply.code(201)
      return manifest
    } catch (err) {
      if (err instanceof FlightConflictError) {
        reply.code(409)
        return { error: err.message, type: 'flight_conflict', existingFlightId: err.existingFlightId }
      }
      throw err
    }
  })

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

  // Snapshot of a stage's agent session (scout / prd-summary / specs-N /
  // coverage-N) — the stage adapters park an agent-session.json ref in the
  // flight's per-stage sidecar dir; AgentSessionView renders this + tails the
  // matching /ws/flights/:id/agent-session for live events.
  app.get<{ Params: { id: string }; Querystring: { stage?: string } }>(
    '/api/flights/:id/agent-session',
    async (req, reply) => {
      const stage = req.query?.stage
      if (!stage || !/^[a-z0-9-]+$/.test(stage)) {
        reply.code(400)
        return { error: 'stage query is required (e.g. scout, prd-summary, specs-1)' }
      }
      const ref = resolveWorkflowAgentRef(path.join(store.flightDir(req.params.id), stage))
      if (!ref) {
        reply.code(404)
        return { reason: 'no-session' }
      }
      const { events, meta } = loadAgentSession(ref)
      return { agent: ref.agent, sessionId: ref.sessionId, model: meta.model, effort: meta.effort, events }
    },
  )

  app.post<{ Params: { id: string } }>('/api/flights/:id/abort', async (req, reply) => {
    try {
      return abortFlight(req.params.id, conductorDeps)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      reply.code(message.includes('not found') ? 404 : 409)
      return { error: message }
    }
  })
}
