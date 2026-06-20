import type { FastifyInstance } from 'fastify'
import { loadFeatures } from '../../config/logic/feature-loader'
import type { OrchestratorLike, RunStore } from '../../runs/logic/run-store'
import {
  createVerificationConfig,
  deriveVerificationTargets,
  getVerificationConfig,
  listVerificationConfigs,
  updateVerificationConfig,
  type ResolveVerificationInput,
} from '../../coverage/logic/verification'
import { isActiveRunStatus } from '../../../../../../shared/run-state'

export interface VerificationRouteDeps {
  featuresDir: string
  store: RunStore
  startVerification(feature: string, input: ResolveVerificationInput): Promise<OrchestratorLike>
}

export async function verificationRoutes(app: FastifyInstance, deps: VerificationRouteDeps): Promise<void> {
  app.get<{ Params: { name: string }; Querystring: { envset?: string } }>(
    '/api/features/:name/verification-targets',
    async (req, reply) => {
      const feature = findFeature(deps.featuresDir, req.params.name)
      if (!feature) {
        reply.code(404)
        return { error: 'feature not found' }
      }
      return deriveVerificationTargets(feature, req.query.envset)
    },
  )

  app.get<{ Params: { name: string } }>(
    '/api/features/:name/verification-configs',
    async (req, reply) => {
      const feature = findFeature(deps.featuresDir, req.params.name)
      if (!feature) {
        reply.code(404)
        return { error: 'feature not found' }
      }
      return listVerificationConfigs(feature)
    },
  )

  app.get<{ Params: { name: string; id: string } }>(
    '/api/features/:name/verification-configs/:id',
    async (req, reply) => {
      const feature = findFeature(deps.featuresDir, req.params.name)
      if (!feature) {
        reply.code(404)
        return { error: 'feature not found' }
      }
      const config = getVerificationConfig(feature, req.params.id)
      if (!config) {
        reply.code(404)
        return { error: 'verification config not found' }
      }
      return config
    },
  )

  app.post<{ Params: { name: string }; Body: SaveConfigBody }>(
    '/api/features/:name/verification-configs',
    async (req, reply) => {
      const feature = findFeature(deps.featuresDir, req.params.name)
      if (!feature) {
        reply.code(404)
        return { error: 'feature not found' }
      }
      const parsed = parseSaveConfigBody(req.body)
      if ('error' in parsed) {
        reply.code(400)
        return { error: parsed.error }
      }
      try {
        reply.code(201)
        return createVerificationConfig(feature, parsed)
      } catch (err) {
        reply.code(statusCodeOf(err))
        return { error: errorMessageOf(err) }
      }
    },
  )

  app.put<{ Params: { name: string; id: string }; Body: SaveConfigBody }>(
    '/api/features/:name/verification-configs/:id',
    async (req, reply) => {
      const feature = findFeature(deps.featuresDir, req.params.name)
      if (!feature) {
        reply.code(404)
        return { error: 'feature not found' }
      }
      const parsed = parseSaveConfigBody(req.body)
      if ('error' in parsed) {
        reply.code(400)
        return { error: parsed.error }
      }
      try {
        const config = updateVerificationConfig(feature, req.params.id, parsed)
        if (!config) {
          reply.code(404)
          return { error: 'verification config not found' }
        }
        return config
      } catch (err) {
        reply.code(statusCodeOf(err))
        return { error: errorMessageOf(err) }
      }
    },
  )

  app.post<{ Params: { name: string }; Body: ExecuteVerificationBody }>(
    '/api/features/:name/verifications',
    async (req, reply) => {
      const feature = findFeature(deps.featuresDir, req.params.name)
      if (!feature) {
        reply.code(404)
        return { error: 'feature not found' }
      }
      const active = deps.store.list().find((run) => isActiveRunStatus(run.status))
      if (active) {
        reply.code(409)
        return { error: `Another execution is ${active.status} (${active.feature}). Stop it first.` }
      }
      const parsed = parseExecuteBody(req.body)
      if ('error' in parsed) {
        reply.code(400)
        return { error: parsed.error }
      }
      try {
        const orch = await deps.startVerification(feature.name, parsed)
        deps.store.registry.set(orch.runId, orch)
        reply.code(201)
        return { runId: orch.runId, executionType: 'verify' }
      } catch (err) {
        reply.code(statusCodeOf(err))
        return { error: errorMessageOf(err) }
      }
    },
  )
}

interface SaveConfigBody {
  name?: unknown
  targetUrls?: unknown
  playwrightEnvsetId?: unknown
}

interface ExecuteVerificationBody {
  configId?: unknown
  targetUrls?: unknown
  playwrightEnvsetId?: unknown
}

function findFeature(featuresDir: string, name: string) {
  return loadFeatures(featuresDir).find((feature) => feature.name === name) ?? null
}

function parseSaveConfigBody(body: SaveConfigBody) {
  if (!body || typeof body !== 'object') return { error: 'request body is required' } as const
  if (typeof body.name !== 'string') return { error: 'name is required' } as const
  if (typeof body.playwrightEnvsetId !== 'string') return { error: 'playwrightEnvsetId is required' } as const
  if (!isStringRecord(body.targetUrls)) return { error: 'targetUrls must be a string map' } as const
  return {
    name: body.name,
    playwrightEnvsetId: body.playwrightEnvsetId,
    targetUrls: body.targetUrls,
  }
}

function parseExecuteBody(body: ExecuteVerificationBody) {
  if (!body || typeof body !== 'object') return {}
  if (body.configId !== undefined && typeof body.configId !== 'string') {
    return { error: 'configId must be a string' } as const
  }
  if (body.playwrightEnvsetId !== undefined && typeof body.playwrightEnvsetId !== 'string') {
    return { error: 'playwrightEnvsetId must be a string' } as const
  }
  if (body.targetUrls !== undefined && !isStringRecord(body.targetUrls)) {
    return { error: 'targetUrls must be a string map' } as const
  }
  return {
    ...(body.configId ? { configId: body.configId } : {}),
    ...(body.playwrightEnvsetId ? { playwrightEnvsetId: body.playwrightEnvsetId } : {}),
    ...(isStringRecord(body.targetUrls) ? { targetUrls: body.targetUrls } : {}),
  }
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  return Object.values(value).every((entry) => typeof entry === 'string')
}

function statusCodeOf(err: unknown): number {
  return typeof (err as { statusCode?: unknown })?.statusCode === 'number'
    ? (err as { statusCode: number }).statusCode
    : 500
}

function errorMessageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
