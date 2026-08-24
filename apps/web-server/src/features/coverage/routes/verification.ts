import type { FastifyInstance } from 'fastify'
import { loadFeatures } from '../../../shared/feature-loader'
import type { OrchestratorLike, RunStore } from '../../runs/logic/run-store'
import {
  createVerificationConfig,
  deriveVerificationTargets,
  getVerificationConfig,
  listVerificationConfigs,
  updateVerificationConfig,
  type ResolveVerificationInput,
} from '../logic/verification'
import { isActiveRunStatus } from '../../../../../../shared/run-state'
import { publishWorkspaceEvent, type WorkspaceEventPublisher } from '../../../shared/workspace-events'
import { GettingStartedBusyError, type GettingStartedOwner, type GettingStartedSessionStore } from '../../config/logic/getting-started-session'

export interface VerificationRouteDeps {
  featuresDir: string
  store: RunStore
  startVerification(
    feature: string,
    input: ResolveVerificationInput,
    options?: { cleanupBootRunId: string },
  ): Promise<OrchestratorLike>
  workspaceEvents?: WorkspaceEventPublisher
  /** Getting Started demo tracking — an execute carrying gettingStartedSource
   *  claims the 'verify' card. Absent in tests → no tracking. */
  gettingStarted?: GettingStartedSessionStore
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
        const created = createVerificationConfig(feature, parsed, deps.workspaceEvents)
        reply.code(201)
        return created
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
        const config = updateVerificationConfig(feature, req.params.id, parsed, deps.workspaceEvents)
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
      const parsed = parseExecuteBody(req.body)
      if ('error' in parsed) {
        reply.code(400)
        return { error: parsed.error }
      }
      const { bootRunId, gettingStartedSource, ...input } = parsed
      if (bootRunId) {
        const boot = deps.store.get(bootRunId)?.manifest
        if (!boot || boot.executionType !== 'boot' || boot.feature !== feature.name || !isActiveRunStatus(boot.status)) {
          reply.code(400)
          return { error: 'bootRunId must name an active boot session for this feature' }
        }
      }
      const active = deps.store.list().find((run) =>
        run.runId !== bootRunId && isActiveRunStatus(run.status),
      )
      if (active) {
        reply.code(409)
        return { error: `Another execution is ${active.status} (${active.feature}). Stop it first.` }
      }
      // A verify demo's work record IS its run, so the claim targets kind 'run'.
      let gettingStartedSession: string | null = null
      if (gettingStartedSource && deps.gettingStarted) {
        try {
          gettingStartedSession = deps.gettingStarted.claim('verify', gettingStartedSource).sessionId
        } catch (err) {
          if (!(err instanceof GettingStartedBusyError)) throw err
          reply.code(409)
          return { type: err.type, error: err.message, active: err.active }
        }
      }
      try {
        const orch = bootRunId
          ? await deps.startVerification(feature.name, input, { cleanupBootRunId: bootRunId })
          : await deps.startVerification(feature.name, input)
        deps.store.registry.set(orch.runId, orch)
        if (gettingStartedSession) {
          deps.gettingStarted?.attach(gettingStartedSession, { kind: 'run', id: orch.runId })
        }
        reply.code(201)
        return { runId: orch.runId, executionType: 'verify' }
      } catch (err) {
        if (gettingStartedSession) deps.gettingStarted?.abandon(gettingStartedSession)
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
  bootRunId?: unknown
  gettingStartedSource?: unknown
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
  if (body.bootRunId !== undefined && typeof body.bootRunId !== 'string') {
    return { error: 'bootRunId must be a string' } as const
  }
  const gettingStartedSource: GettingStartedOwner | undefined =
    body.gettingStartedSource === 'internal' || body.gettingStartedSource === 'external'
      ? body.gettingStartedSource
      : undefined
  if (body.gettingStartedSource !== undefined && !gettingStartedSource) {
    return { error: "gettingStartedSource must be 'internal' or 'external'" } as const
  }
  return {
    ...(body.configId ? { configId: body.configId } : {}),
    ...(body.playwrightEnvsetId ? { playwrightEnvsetId: body.playwrightEnvsetId } : {}),
    ...(isStringRecord(body.targetUrls) ? { targetUrls: body.targetUrls } : {}),
    ...(body.bootRunId ? { bootRunId: body.bootRunId } : {}),
    ...(gettingStartedSource ? { gettingStartedSource } : {}),
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
