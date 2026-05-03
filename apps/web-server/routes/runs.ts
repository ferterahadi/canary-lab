import type { FastifyInstance } from 'fastify'
import { listRuns, getRunDetail, removeRunFromHistory, type OrchestratorRegistry, type OrchestratorLike } from '../lib/run-store'
import { loadFeatures } from '../lib/feature-loader'

export interface RunsRouteDeps {
  logsDir: string
  featuresDir: string
  registry: OrchestratorRegistry
  // Factory: given a feature name, build + start an orchestrator. Returns the
  // runId synchronously after `start()` is in flight (the factory awaits the
  // initial spawn but not test completion). Injected so tests can stub it.
  startRun(feature: string, env?: string): Promise<OrchestratorLike>
}

export async function runsRoutes(app: FastifyInstance, deps: RunsRouteDeps): Promise<void> {
  app.get<{ Querystring: { feature?: string } }>('/api/runs', async (req) => {
    return listRuns(deps.logsDir, { feature: req.query.feature })
  })

  app.get<{ Params: { runId: string } }>('/api/runs/:runId', async (req, reply) => {
    const detail = getRunDetail(deps.logsDir, req.params.runId)
    if (!detail) {
      reply.code(404)
      return { error: 'run not found' }
    }
    return detail
  })

  app.post<{ Body: { feature?: string; env?: string } }>('/api/runs', async (req, reply) => {
    const feature = req.body?.feature
    if (typeof feature !== 'string' || feature.length === 0) {
      reply.code(400)
      return { error: 'feature required' }
    }
    const features = loadFeatures(deps.featuresDir)
    const featureCfg = features.find((f) => f.name === feature)
    if (!featureCfg) {
      reply.code(404)
      return { error: 'feature not found' }
    }
    // env is optional only when the feature didn't declare any. Otherwise it
    // must be one of feature.envs (default: first entry).
    const declared = featureCfg.envs ?? []
    const env = declared.length > 0 ? (req.body?.env ?? declared[0]) : undefined
    if (declared.length > 0 && (typeof env !== 'string' || !declared.includes(env))) {
      reply.code(400)
      return { error: `env must be one of: ${declared.join(', ')}` }
    }
    try {
      const orch = await deps.startRun(feature, env)
      deps.registry.set(orch.runId, orch)
      reply.code(201)
      return { runId: orch.runId }
    } catch (err) {
      reply.code(500)
      return { error: err instanceof Error ? err.message : String(err) }
    }
  })

  // Mid-Run Heal: manual interruption. Looks up the orchestrator in the
  // registry, asks it to SIGTERM Playwright + jump into the heal cycle.
  // 404 when unknown, 409 with a reason when pausing is meaningless,
  // 202 + status payload on success.
  app.post<{ Params: { runId: string } }>('/api/runs/:runId/pause-heal', async (req, reply) => {
    const orch = deps.registry.get(req.params.runId)
    if (!orch) {
      reply.code(404)
      return { error: 'run not active' }
    }
    const result = await orch.pauseAndHeal()
    if (!result.ok) {
      reply.code(409)
      return { reason: result.reason }
    }
    reply.code(202)
    return { status: 'healing', failureCount: result.failureCount }
  })

  // Cancel an in-flight heal cycle. SIGTERMs the agent pty, breaks the heal
  // loop, appends a journal entry. 404 when unknown, 409 with a reason when
  // there's nothing to cancel, 202 on success.
  app.post<{ Params: { runId: string } }>('/api/runs/:runId/cancel-heal', async (req, reply) => {
    const orch = deps.registry.get(req.params.runId)
    if (!orch) {
      reply.code(404)
      return { error: 'run not active' }
    }
    const result = await orch.cancelHeal()
    if (!result.ok) {
      reply.code(409)
      return { reason: result.reason }
    }
    reply.code(202)
    return { status: 'cancelled' }
  })

  // Live interject — pipe a line of text to the running heal agent's stdin
  // so the user can guide the agent without restarting the cycle. 404 when
  // unknown, 409 when there's no agent running for this run.
  app.post<{ Params: { runId: string }; Body: { data: string } }>(
    '/api/runs/:runId/agent-input',
    async (req, reply) => {
      const orch = deps.registry.get(req.params.runId)
      if (!orch) {
        reply.code(404)
        return { error: 'run not active' }
      }
      if (typeof req.body?.data !== 'string') {
        reply.code(400)
        return { error: 'data must be a string' }
      }
      if (!orch.interjectHealAgent) {
        reply.code(409)
        return { reason: 'no-agent-running' }
      }
      const result = await orch.interjectHealAgent(req.body.data)
      if (!result.ok) {
        reply.code(result.reason === 'spawn-failed' ? 500 : 409)
        return { reason: result.reason }
      }
      reply.code(202)
      return { status: 'sent' }
    },
  )

  // POST /api/runs/:runId/abort — explicit abort of an active run. Stops
  // the orchestrator (kills Playwright + heal agent + service ptys) and
  // marks the manifest 'aborted'. The run is preserved in history so the
  // user can audit the logs after. 404 when not active, 204 on success.
  app.post<{ Params: { runId: string } }>('/api/runs/:runId/abort', async (req, reply) => {
    const runId = req.params.runId
    const orch = deps.registry.get(runId)
    if (!orch) {
      reply.code(404)
      return { error: 'run not active' }
    }
    try { await orch.stop('aborted') } catch { /* best-effort */ }
    deps.registry.delete(runId)
    reply.code(204)
    return ''
  })

  // DELETE /api/runs/:runId — hard-remove a terminal run (passed/failed/
  // aborted) from history: drop the index entry and recursively delete the
  // run directory. Refuses (409) if the run is still active — callers must
  // hit POST /abort first. 404 when nothing matches the runId at all.
  app.delete<{ Params: { runId: string } }>('/api/runs/:runId', async (req, reply) => {
    const runId = req.params.runId
    if (deps.registry.get(runId)) {
      // Run is currently being orchestrated — refuse so the action matrix
      // is honored end-to-end (delete is for terminal runs only).
      reply.code(409)
      return { error: 'run is still active; abort it first' }
    }
    const detail = getRunDetail(deps.logsDir, runId)
    if (!detail) {
      reply.code(404)
      return { error: 'run not found' }
    }
    const status = detail.manifest.status
    if (status === 'running' || status === 'healing') {
      // Manifest claims active but no orch — stale (e.g. server crash).
      // Refuse so the next boot-time reaper or a fresh run can resolve
      // the discrepancy; same response shape as the in-registry case.
      reply.code(409)
      return { error: 'run is still active; reap or abort first' }
    }
    removeRunFromHistory(deps.logsDir, runId)
    reply.code(204)
    return ''
  })
}
