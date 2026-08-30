// Flights REST — the multi-repo plan surface (propose a plan, poll the task,
// launch the planned flights) plus stage evidence and abort. Bodies unchanged.
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { FastifyInstance } from 'fastify'
import type { FlightRouteDeps } from './flight-route-deps'
import type { FlightRouteContext } from './flight-route-context'
import {
  buildAgentSessionResponse,
  resolveWorkflowAgentRef,
} from '../../agent-sessions/logic/agent-session-log'
import { abortFlight, drainQueuedFlights } from '../logic/conductor'
import { deriveFeatureSlug, isTerminalFlightStatus, type PlannedFeature, type PlanFeaturesTask } from '../../../../../../shared/flights/types'
import { cancelPlanFeatures, startPlanFeatures } from '../logic/plan-features'
import { publishWorkspaceEvent } from '../../../shared/workspace-events'
import { executePlannedLaunch, expandHome, resolveFlightModels } from './flight-route-support'

export async function registerFlightPlanRoutes(app: FastifyInstance, deps: FlightRouteDeps, ctx: FlightRouteContext): Promise<void> {
  const { store, planStore, conductorDeps } = ctx

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
                // No launch gate on the backgrounded auto-launch — the plan is
                // the workspace defaults, resolved for the conducting agent.
                models: resolveFlightModels(deps.projectRoot, settled.agent ?? 'claude', undefined),
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

  app.post<{ Params: { taskId: string } }>(
    '/api/flights/plan-features/:taskId/cancel',
    async (req, reply) => {
      try {
        const task = await cancelPlanFeatures(req.params.taskId, planStore)
        // A stale planning frame can lose the last-millisecond race to the
        // server's single-feature auto-launch. Stop queued siblings first so
        // aborting the active flight cannot drain and start one between calls.
        const descendants = (task.launchedFlightIds ?? [])
          .map((flightId) => store.get(flightId))
          .filter((flight): flight is NonNullable<typeof flight> =>
            flight !== null && !isTerminalFlightStatus(flight.status))
          .sort((a, b) => Number(a.status === 'running' || a.status === 'waiting-for-approval')
            - Number(b.status === 'running' || b.status === 'waiting-for-approval'))
        for (const flight of descendants) await abortFlight(flight.flightId, conductorDeps)
        return planStore.get(req.params.taskId) ?? task
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        const statusCode = err instanceof Error && 'statusCode' in err
          ? Number((err as Error & { statusCode: number }).statusCode)
          : 500
        reply.code(statusCode)
        return { error: message }
      }
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
          /** Launch-gate override for every launched flight, laid over the
           *  workspace config exactly like the single-flight start route. */
          models?: unknown
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
      return { error: task.status === 'running' ? 'Planning is still running — wait for the proposal before launching.' : `Planning ${task.status} — nothing to launch.` }
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
        return { error: 'Every suite needs a name and a description.' }
      }
      features.push({ name, description, ...(f?.group ? { group: deriveFeatureSlug(String(f.group)) } : {}) })
    }
    if (new Set(features.map((f) => f.name)).size !== features.length) {
      reply.code(400)
      return { error: 'Suite names must be unique.' }
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
        models: resolveFlightModels(
          deps.projectRoot,
          (body.agent ?? task.agent) === 'codex' ? 'codex' : 'claude',
          body.models,
        ),
      },
      { store, featuresDir: deps.featuresDir, conductorDeps, workspaceEvents: deps.workspaceEvents },
    )
    if (!outcome.launched) {
      reply.code(409)
      return {
        error: `These suite names are already taken: ${outcome.conflicts.join(', ')} — rename them in the proposal.`,
        type: 'feature_name_conflicts',
        conflicts: outcome.conflicts,
      }
    }
    planStore.save({ ...task, status: 'launched', launchedFlightIds: outcome.flightIds, updatedAt: new Date().toISOString() })
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
      return await abortFlight(req.params.id, conductorDeps)
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
