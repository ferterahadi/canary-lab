import fs from 'fs'
import os from 'os'
import path from 'path'
import type { FastifyInstance } from 'fastify'
import {
  buildAgentSessionResponse,
  resolveWorkflowAgentRef,
} from '../../agent-sessions/logic/agent-session-log'
import { FlightRunStore, type FlightStore } from '../logic/store'
import {
  FlightConflictError,
  FlightExistsError,
  FlightFrozenError,
  FlightStageEntryError,
  startFlight,
  resumeFlight,
  setFlightAutopilot,
  respondToFlightCheckpoint,
  abortFlight,
  pauseFlight,
  redoFlight,
  deleteFlight,
  enqueueFlight,
  drainQueuedFlights,
  type FlightConductorDeps,
  type FlightEntryMode,
  type StageAdapters,
} from '../logic/conductor'
import {
  FLIGHT_STAGE_KEYS,
  isActiveFlightStatus,
  type FlightCheckpointResponse,
  type FlightEntryOptions,
  type FlightOptions,
  type FlightStageEntryOption,
  type FlightStageKey,
} from '../logic/types'
import { deriveFeatureSlug, type PlannedFeature, type PlanFeaturesTask } from '../../../../../../shared/flights/types'
import { PlanFeaturesStore, startPlanFeatures, type PlanAutoLaunchOutcome } from '../logic/plan-features'
import type { FlightAgentSpawner } from '../logic/stages/context'
import { hasAuthoredSpecs, hasCapturedEnvset, hasPrdSummary } from '../logic/stage-evidence'
import { loadFeatures } from '../../config/logic/feature-loader'
import { publishWorkspaceEvent, type WorkspaceEventPublisher } from '../../../shared/workspace-events'

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
  /** Shared plan-features store (boot reconcile owns it). Omitted in tests →
   *  a fresh file-backed store over logsDir. */
  planStore?: PlanFeaturesStore
  /** Test seam for the plan-features agent spawn. */
  planAgent?: FlightAgentSpawner
  workspaceEvents?: WorkspaceEventPublisher
}

// Flight REST surface — the same store/conductor the MCP flight tools
// drive (dual-surface parity). Start is non-blocking: it validates input,
// creates the running manifest, kicks the conductor off detached, and returns
// 201 with the manifest; progress is read back via GET (UI/CLI poll or ride
// the `flights-changed` WorkspaceEvent).

/** Harness-side prerequisite check for a `fromStage` entry. Each stage that
 *  would be skipped must already have its on-disk artifact — the same evidence
 *  the stage itself would have produced. Returns the FIRST missing
 *  prerequisite as a human-readable reason, or null when the jump is OK. */
export function buildStageEntryValidator(featuresDir: string) {
  return (args: {
    feature: string
    fromStage: FlightStageKey
    env: string
    existing?: { links?: { runId?: string } } | null
  }): string | null => {
    const { feature, fromStage, env } = args
    const featureDir = path.join(featuresDir, feature)
    const after = (stage: FlightStageKey) =>
      FLIGHT_STAGE_KEYS.indexOf(fromStage) > FLIGHT_STAGE_KEYS.indexOf(stage)

    if (fromStage === 'heal') {
      return 'cannot start at "heal" — heal is driven by the run stage; use --from-stage run'
    }
    if (after('scaffold') && !fs.existsSync(path.join(featureDir, 'feature.config.cjs'))) {
      return `cannot start at "${fromStage}": feature "${feature}" has no feature.config.cjs (scaffold prerequisite) — start from scout/scaffold instead`
    }
    if (after('env-capture') && !hasCapturedEnvset(featureDir, env)) {
      return `cannot start at "${fromStage}": no captured envset at envsets/${env}/ (env-capture prerequisite) — start from env-capture instead`
    }
    if (after('prd-summary') && !hasPrdSummary(featureDir)) {
      return `cannot start at "${fromStage}": no PRD summary at docs/_prd-summary.json (prd-summary prerequisite) — start from docs instead`
    }
    if (after('specs-coverage') && !hasAuthoredSpecs(featureDir)) {
      return `cannot start at "${fromStage}": no specs under e2e/ (specs-coverage prerequisite) — start from specs-coverage instead`
    }
    if (fromStage === 'evaluation-export' && !args.existing?.links?.runId) {
      return 'cannot start at "evaluation-export": the flight record has no run yet (run prerequisite) — start from run instead'
    }
    return null
  }
}

/** Expand a leading `~` the way the entry prefill does — feature configs (and
 *  therefore the dialog's repo picker) may declare repos home-relative. */
function expandHome(p: string): string {
  return p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p
}

export interface PlannedLaunchDeps {
  store: FlightStore
  featuresDir: string
  conductorDeps: FlightConductorDeps
  workspaceEvents?: WorkspaceEventPublisher
}

/** Mint one flight per planned feature — the first running, the rest parked
 *  `queued` for the conductor's sequential drain. Synchronous (startFlight /
 *  enqueueFlight kick their agents off detached), so both callers — the
 *  `/launch` route (user-confirmed proposal) and the plan agent's single-feature
 *  auto-launch — run to completion without an await gap, and the plan-task
 *  status flip that guards against a double launch is atomic. `features` must
 *  already be validated (named + described + unique); name collisions are
 *  settled up front so a partial launch can't happen. */
export function executePlannedLaunch(
  args: {
    repoPaths: string[]
    features: PlannedFeature[]
    env: string
    coverageTarget: number
    yolo: boolean
    /** Absent = autopilot on (R71/W4). */
    autopilot?: boolean
    /** R79: the CLI conducting every launched flight. Absent = claude. */
    agent?: 'claude' | 'codex'
  },
  deps: PlannedLaunchDeps,
): PlanAutoLaunchOutcome {
  const conflicts = args.features
    .map((f) => f.name)
    .filter(
      (name) =>
        deps.store.latestForFeature(name) !== null ||
        fs.existsSync(path.join(deps.featuresDir, name)),
    )
  if (conflicts.length > 0) return { launched: false, conflicts }

  const optsFor = (f: PlannedFeature): FlightOptions => ({
    env: args.env,
    coverageTarget: args.coverageTarget,
    yolo: args.yolo,
    ...(args.autopilot === false ? { autopilot: false } : {}),
    ...(args.agent ? { agent: args.agent } : {}),
    // The proposal step already answered "new feature over this repo?" for
    // every sibling — similarity must not re-ask (or yolo-rerun the first).
    plannedSplit: true,
    ...(f.group ? { group: f.group } : {}),
  })
  const flightIds: string[] = []
  for (const [i, f] of args.features.entries()) {
    const launchArgs = { feature: f.name, repoPaths: args.repoPaths, description: f.description, opts: optsFor(f) }
    if (i === 0) {
      try {
        flightIds.push(startFlight(launchArgs, deps.conductorDeps).manifest.flightId)
        continue
      } catch (err) {
        // Repo already busy with an unrelated active flight → park this one
        // queued too; the drain starts it when the repo frees up.
        if (!(err instanceof FlightConflictError)) throw err
      }
    }
    flightIds.push(enqueueFlight(launchArgs, deps.conductorDeps).flightId)
  }
  publishWorkspaceEvent(deps.workspaceEvents, { type: 'flights-changed' })
  return { launched: true, flightIds }
}

export async function flightsRoutes(app: FastifyInstance, deps: FlightRouteDeps): Promise<void> {
  const store = deps.flightStore ?? new FlightRunStore(deps.logsDir)
  const planStore = deps.planStore ?? new PlanFeaturesStore(deps.logsDir)
  const conductorDeps: FlightConductorDeps = {
    store,
    adapters: deps.adapters,
    workspaceEvents: deps.workspaceEvents,
    validateStageEntry: buildStageEntryValidator(deps.featuresDir),
  }

  // One row per feature: the invariant is one flight record per feature, but
  // pre-invariant history left superseded records in the index — collapse to
  // the latest (list is newest-first) instead of destructively pruning disk.
  app.get('/api/flights', async () => {
    const seen = new Set<string>()
    const flights = store.list().filter((e) => {
      if (seen.has(e.feature)) return false
      seen.add(e.feature)
      return true
    })
    return { flights }
  })

  // Stage-entry menu for one feature (the UI's "flight from here" dialog).
  // Static segment, so it never shadows /api/flights/:id.
  app.get<{ Querystring: { feature?: string; env?: string } }>(
    '/api/flights/entry',
    async (req, reply) => {
      const feature = req.query?.feature?.trim()
      if (!feature) {
        reply.code(400)
        return { error: 'feature query is required' }
      }
      const env = req.query?.env?.trim() || 'local'

      const entry = store.latestForFeature(feature)
      const manifest = entry ? store.get(entry.flightId) : null
      // Best-effort config read for the prefill — a config that fails
      // validation elsewhere must not take the entry menu down with it.
      let config
      try {
        config = loadFeatures(deps.featuresDir).find((c) => c.name === feature)
      } catch {
        config = undefined
      }
      if (!manifest && !config) {
        reply.code(404)
        return { error: `feature not set up: ${feature} (no flight record and no feature.config)` }
      }

      // A feature that has never flown always starts from the beginning — the
      // stage-entry menu unlocks only once a flight record exists (R41). The
      // start route itself stays permissive for CLI power users.
      const validate = buildStageEntryValidator(deps.featuresDir)
      const stages: FlightStageEntryOption[] = FLIGHT_STAGE_KEYS.map((key) => {
        if (!manifest && key !== 'similarity') {
          return { key, allowed: false, reason: 'available after this feature\'s first flight' }
        }
        const reason = validate({ feature, fromStage: key, env, existing: manifest })
        return reason ? { key, allowed: false, reason } : { key, allowed: true }
      })

      // Configs may declare repos as `~/...` — expand so the prefill posts
      // paths the start route's realpath check accepts.
      const configRepoPaths = (config?.repos ?? [])
        .map((r) => r.localPath)
        .filter((p): p is string => typeof p === 'string' && p.length > 0)
        .map((p) => (p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p))
      const options: FlightEntryOptions = {
        feature,
        flight: manifest
          ? {
              flightId: manifest.flightId,
              status: manifest.status,
              stages: manifest.stages.map((s) => ({ key: s.key, status: s.status })),
            }
          : null,
        active: manifest ? isActiveFlightStatus(manifest.status) : false,
        canContinue: manifest?.status === 'paused',
        prefill: {
          repoPaths: manifest?.repoPaths ?? configRepoPaths,
          description: manifest?.description ?? '',
          env: manifest?.opts.env ?? env,
          coverageTarget: manifest?.opts.coverageTarget ?? 100,
        },
        stages,
      }
      return options
    },
  )

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
          /** Absent = on; only an explicit false opts out (R71/W4). */
          autopilot?: boolean
          /** R79: which CLI conducts the flight's stage agents; sticky per
           *  record (jump/continue reuse the stored one). Absent → claude. */
          agent?: string
          /** continue | redo | jump — required when the feature already has a
           *  flight record (409 flight_exists_requires_choice otherwise). */
          mode?: string
          /** Stage to start at (jump / fresh stage entry), prereq-validated. */
          fromStage?: string
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
      reply.code(201)
      return manifest
    } catch (err) {
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

  // User-initiated pause: parks the flight resumable and cancels the in-flight
  // stage work (agent SIGTERM / poll abort). The run stage's run keeps its own
  // lifecycle — see the run adapter's interrupt note.
  app.post<{ Params: { id: string } }>('/api/flights/:id/pause', async (req, reply) => {
    try {
      return pauseFlight(req.params.id, conductorDeps)
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

  app.post<{ Body: { repoPaths?: string[]; description?: string; autopilot?: boolean; agent?: string } | undefined }>(
    '/api/flights/plan-features',
    async (req, reply) => {
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
      const resolved: string[] = []
      for (const p of repoPaths) {
        try {
          resolved.push(fs.realpathSync(path.resolve(expandHome(p))))
        } catch {
          reply.code(400)
          return { error: `repo path does not exist: ${p}` }
        }
      }
      const task = startPlanFeatures(
        {
          repoPaths: resolved,
          description: body.description.trim(),
          ...(body.autopilot === false ? { autopilot: false } : {}),
          ...(body.agent === 'claude' || body.agent === 'codex' ? { agent: body.agent } : {}),
        },
        planStore,
        {
          logsDir: deps.logsDir,
          spawnAgent: deps.planAgent,
          workspaceEvents: deps.workspaceEvents,
          // A single-feature plan launches itself — even if the dialog is
          // closed (backgrounded). Multi-feature is left for the proposal.
          // The task carries the dialog's autopilot choice (R71/W4).
          autoLaunch: (settled) =>
            executePlannedLaunch(
              {
                repoPaths: settled.repoPaths,
                features: settled.result!.features,
                env: 'local',
                coverageTarget: 100,
                yolo: false,
                ...(settled.autopilot === false ? { autopilot: false } : {}),
                ...(settled.agent ? { agent: settled.agent } : {}),
              },
              { store, featuresDir: deps.featuresDir, conductorDeps, workspaceEvents: deps.workspaceEvents },
            ),
        },
      )
      reply.code(202)
      return task
    },
  )

  // The pre-flight list behind the Flights pill's pre-flight rows — every plan
  // task still needing continuation (running) or the user's confirmation
  // (done: a multi-feature proposal, or a single feature whose name clashed).
  // `launched`/`failed` are terminal and drop off (a failed backgrounded plan
  // produced nothing — the user re-plans from "+ New").
  app.get('/api/flights/plan-features', async () => {
    const tasks = planStore
      .list()
      .filter((e) => e.status === 'running' || e.status === 'done')
      .map((e) => planStore.get(e.id))
      .filter((t): t is PlanFeaturesTask => t !== null)
    return { tasks }
  })

  app.get<{ Params: { taskId: string } }>(
    '/api/flights/plan-features/:taskId',
    async (req, reply) => {
      const task = planStore.get(req.params.taskId)
      if (!task) {
        reply.code(404)
        return { error: `plan task not found: ${req.params.taskId}` }
      }
      return task
    },
  )

  app.get<{ Params: { taskId: string } }>(
    '/api/flights/plan-features/:taskId/agent-session',
    async (req, reply) => {
      const ref = resolveWorkflowAgentRef(planStore.recordDir(req.params.taskId))
      if (!ref) {
        reply.code(404)
        return { reason: 'no-session' }
      }
      return buildAgentSessionResponse(ref)
    },
  )

  app.post<{
    Params: { taskId: string }
    Body:
      | {
          features?: Array<Partial<PlannedFeature>>
          env?: string
          coverageTarget?: number
          yolo?: boolean
          /** Absent = the task's stored choice; explicit false opts out. */
          autopilot?: boolean
          /** Absent = the task's stored choice. */
          agent?: string
        }
      | undefined
  }>('/api/flights/plan-features/:taskId/launch', async (req, reply) => {
    const task = planStore.get(req.params.taskId)
    if (!task) {
      reply.code(404)
      return { error: `plan task not found: ${req.params.taskId}` }
    }
    if (task.status !== 'done') {
      reply.code(409)
      return { error: `plan task is ${task.status} — only a settled proposal can launch` }
    }
    const body = req.body ?? {}
    const raw = Array.isArray(body.features) ? body.features : []
    if (raw.length === 0) {
      reply.code(400)
      return { error: 'features (non-empty array) is required' }
    }
    const features: PlannedFeature[] = []
    for (const f of raw) {
      const name = deriveFeatureSlug(String(f?.name ?? ''))
      const description = String(f?.description ?? '').trim()
      if (!name || name === 'feature' || !description) {
        reply.code(400)
        return { error: 'every feature needs a slug name and a description' }
      }
      features.push({ name, description, ...(f?.group ? { group: deriveFeatureSlug(String(f.group)) } : {}) })
    }
    if (new Set(features.map((f) => f.name)).size !== features.length) {
      reply.code(400)
      return { error: 'feature names must be unique' }
    }
    // The shared helper settles name collisions BEFORE anything is created — a
    // partial launch (2 of 5 flights minted) would be worse than a rejection.
    const outcome = executePlannedLaunch(
      {
        repoPaths: task.repoPaths,
        features,
        env: body.env ?? 'local',
        coverageTarget: body.coverageTarget ?? 100,
        yolo: body.yolo === true,
        ...((body.autopilot ?? task.autopilot) === false ? { autopilot: false } : {}),
        ...((body.agent ?? task.agent) === 'claude' || (body.agent ?? task.agent) === 'codex'
          ? { agent: (body.agent ?? task.agent) as 'claude' | 'codex' }
          : {}),
      },
      { store, featuresDir: deps.featuresDir, conductorDeps, workspaceEvents: deps.workspaceEvents },
    )
    if (!outcome.launched) {
      reply.code(409)
      return {
        error: `feature name(s) already in use: ${outcome.conflicts.join(', ')} — rename them in the proposal`,
        type: 'feature_name_conflicts',
        conflicts: outcome.conflicts,
      }
    }
    planStore.save({ ...task, status: 'launched', launchedFlightIds: outcome.flightIds, updatedAt: new Date().toISOString() })
    publishWorkspaceEvent(deps.workspaceEvents, { type: 'pre-flight-changed' })
    reply.code(201)
    return { flightIds: outcome.flightIds }
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
      return buildAgentSessionResponse(ref)
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

  // Boot drain: a server restart may have interrupted a plan-features batch
  // mid-queue — reconcile parked the running flight `paused`, so a `queued`
  // sibling whose repos are free can proceed now that adapters exist.
  drainQueuedFlights(conductorDeps)
}
