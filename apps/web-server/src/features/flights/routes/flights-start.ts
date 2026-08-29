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
import { expandHome, parseFlightExternalAgentSession, reclaimGettingStartedFlight, resolveFlightModels } from './flight-route-support'
import { GettingStartedBusyError, type GettingStartedOwner, type GettingStartedWorkflow } from '../../config/logic/getting-started-session'

/** The author/portify/export demos launch a flight pinned to their stage, so
 *  the flight-start claim must land under the DEMO's workflow key, not
 *  'flight' — otherwise the Getting Started card for the invoked skill never
 *  lights. Unknown values degrade to 'flight', matching how `agent` and
 *  `stageProducer` treat an older client's nonsense. */
function claimWorkflowFor(value: string | undefined): GettingStartedWorkflow {
  const known: GettingStartedWorkflow[] = ['run', 'flight', 'coverage', 'author', 'portify', 'verify', 'export']
  return known.find((workflow) => workflow === value) ?? 'flight'
}

export async function registerFlightStartRoutes(app: FastifyInstance, deps: FlightRouteDeps, ctx: FlightRouteContext): Promise<void> {
  const { store, planStore, conductorDeps } = ctx

  /** The stored record's conducting agent (index rows don't carry opts). */
  const storedAgentFor = (feature: string): 'claude' | 'codex' | undefined => {
    const latest = store.latestForFeature(feature)
    return latest ? store.get(latest.flightId)?.opts.agent : undefined
  }

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
          /** Launch-gate override: this flight's per-stage model+effort plan
           *  for the conducting agent, laid over the workspace `agentModels`
           *  config. The merged plan is persisted on the record at start
           *  (sticky like `agent`); the override itself is never written back
           *  to config. */
          models?: unknown
          /** The Claude/Codex conversation driving an external Flight. */
          externalAgentSession?: unknown
          /** continue | redo | jump — required when the feature already has a
           *  flight record (409 flight_exists_requires_choice otherwise). */
          mode?: string
          /** Stage to start at (jump / fresh stage entry), prereq-validated. */
          fromStage?: string
          /** "What went wrong last time" (R74), scoped to the entry stage's
           *  agent prompt. Redo/jump only — the conductor drops it otherwise.
           *  Reachable here (not only on `/:id/redo`) because an externally
           *  driven flight re-enters a stage through start_flight, and without
           *  it the agent could repeat a step but never say why. */
          feedback?: string
          gettingStartedSource?: GettingStartedOwner
          /** Which Getting Started card this start belongs to. The
           *  author/portify/export demos run AS a flight but must claim their
           *  own workflow key so their card lights. Absent/unknown → 'flight'. */
          gettingStartedWorkflow?: string
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
    // These two are the validators a person can actually reach from the
    // launcher, so they read as instructions, not field-and-type prose.
    if (!hasMode && repoPaths.length === 0) {
      reply.code(400)
      return { error: 'Pick at least one repo folder first.' }
    }
    const description = typeof body.description === 'string' ? body.description.trim() : ''
    if (!hasMode && description === '') {
      reply.code(400)
      return { error: 'Say what this flight should test first.' }
    }
    if (typeof body.feature !== 'string' || body.feature.trim() === '') {
      reply.code(400)
      return { error: 'feature is required' }
    }
    const coverageTarget = body.coverageTarget ?? 100
    if (typeof coverageTarget !== 'number' || coverageTarget < 0 || coverageTarget > 100) {
      reply.code(400)
      return { error: 'Coverage target must be a number between 0 and 100.' }
    }
    const externalAgentSession = parseFlightExternalAgentSession(body.externalAgentSession)
    if (externalAgentSession && 'error' in externalAgentSession) {
      reply.code(400)
      return { error: externalAgentSession.error }
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

    const agent = body.agent === 'claude' || body.agent === 'codex' ? body.agent : undefined
    const opts: FlightOptions = {
      env: body.env ?? 'local',
      coverageTarget,
      ...(body.base ? { base: body.base } : {}),
      yolo: body.yolo === true,
      ...(body.autopilot === false ? { autopilot: false } : {}),
      ...(agent ? { agent } : {}),
      // Unknown values are dropped rather than rejected, matching `agent` above:
      // an older client sending nonsense degrades to the internal default instead
      // of failing a flight start.
      ...(body.stageProducer === 'internal' || body.stageProducer === 'external' ? { stageProducer: body.stageProducer } : {}),
      // Resolved NOW and persisted on the record: launch override → workspace
      // config → agent default, snapshotted so a later config edit cannot
      // change a flight mid-pipeline (the conductor keeps it sticky like
      // `agent`; a redo re-resolves). Always set, `{}` included — an absent
      // plan is what a pre-2.2.0 record looks like. A mode-carrying call may
      // omit `agent`, so the stored record supplies the agent whose plan to
      // resolve — resolving for the wrong CLI would persist efforts the other
      // CLI's vocabulary rejects.
      models: resolveFlightModels(
        deps.projectRoot,
        agent ?? (hasMode ? storedAgentFor(body.feature.trim()) : undefined) ?? 'claude',
        body.models,
      ),
    }

    let gettingStartedSession: string | null = null
    if (body.gettingStartedSource && deps.gettingStarted) {
      try {
        gettingStartedSession = deps.gettingStarted.claim(claimWorkflowFor(body.gettingStartedWorkflow), body.gettingStartedSource).sessionId
      } catch (err) {
        if (!(err instanceof GettingStartedBusyError)) throw err
        reply.code(409)
        return { type: err.type, error: err.message, active: err.active }
      }
    } else if (hasMode && deps.gettingStarted) {
      // A mode-carrying start (continue/redo/jump) re-enters an existing record,
      // and no client sends gettingStartedSource on those — so the demo flight
      // has to be recognized and re-claimed here the same way resume does. The
      // stored record supplies repoPaths when the body omitted them.
      try {
        const existing = store.latestForFeature(body.feature.trim())
        gettingStartedSession = reclaimGettingStartedFlight(
          deps.gettingStarted, req.headers,
          { feature: body.feature.trim(), repoPaths: resolved.length > 0 ? resolved : existing?.repoPaths },
          existing?.flightId ?? null,
        )
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
          ...(externalAgentSession ? { externalAgentSession } : {}),
          ...(body.mode ? { mode: body.mode as FlightEntryMode } : {}),
          ...(body.fromStage ? { fromStage: body.fromStage as FlightStageKey } : {}),
          ...(body.feedback ? { feedback: body.feedback } : {}),
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
