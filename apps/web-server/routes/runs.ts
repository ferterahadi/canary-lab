import type { FastifyInstance } from 'fastify'
import { listRuns, getRunDetail, type OrchestratorRegistry, type OrchestratorLike } from '../lib/run-store'
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

  app.delete<{ Params: { runId: string } }>('/api/runs/:runId', async (req, reply) => {
    const runId = req.params.runId
    const orch = deps.registry.get(runId)
    if (orch) {
      try { await orch.stop('aborted') } catch { /* best-effort */ }
      deps.registry.delete(runId)
    } else {
      // Confirm at least the manifest exists so we can 404 unknown ids.
      const detail = getRunDetail(deps.logsDir, runId)
      if (!detail) {
        reply.code(404)
        return { error: 'run not found' }
      }
    }
    reply.code(204)
    return ''
  })
}
