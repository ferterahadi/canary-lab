import type { FastifyInstance } from 'fastify'
import type { PortifyStore } from '../lib/runtime/portify/store'
import type { PortifyManifest, StartPortifyInput, StartPortifyResult } from '../lib/runtime/portify/types'
import type { HealAgent } from '../lib/runtime/auto-heal'

// REST surface for the port-ification workflow, mirroring routes/benchmarks.ts.
// Reads go through the injected store; start/commit/cancel delegate to the
// injected runner. The wizard polls GET /api/portify/:id for live status.

export interface PortifyRouteDeps {
  store: PortifyStore
  startPortify(input: StartPortifyInput): Promise<StartPortifyResult>
  commitPortify(workflowId: string): Promise<PortifyManifest>
  cancelPortify(workflowId: string): Promise<PortifyManifest>
  loadAgentSession(workflowId: string): { agent: string; sessionId: string; events: unknown[] } | null
}

interface StartBody {
  feature?: string
  agent?: string
  maxAttempts?: number
}

export async function portifyRoutes(app: FastifyInstance, deps: PortifyRouteDeps): Promise<void> {
  app.get('/api/portify', async () => deps.store.list())

  app.post<{ Body: StartBody }>('/api/portify', async (req, reply) => {
    const body = req.body ?? {}
    const feature = typeof body.feature === 'string' ? body.feature.trim() : ''
    if (!feature) {
      reply.code(400)
      return { error: 'feature is required' }
    }
    const agent: HealAgent | undefined =
      body.agent === 'codex' ? 'codex' : body.agent === 'claude' ? 'claude' : undefined
    const maxAttempts = Number.isInteger(body.maxAttempts) ? body.maxAttempts : undefined
    try {
      return await deps.startPortify({ feature, agent, maxAttempts })
    } catch (err) {
      reply.code((err as { statusCode?: number }).statusCode ?? 500)
      return { error: err instanceof Error ? err.message : String(err) }
    }
  })

  app.get<{ Params: { workflowId: string } }>('/api/portify/:workflowId', async (req, reply) => {
    const manifest = deps.store.get(req.params.workflowId)
    if (!manifest) {
      reply.code(404)
      return { error: 'workflow not found' }
    }
    return manifest
  })

  app.get<{ Params: { workflowId: string } }>('/api/portify/:workflowId/agent-session', async (req, reply) => {
    const session = deps.loadAgentSession(req.params.workflowId)
    if (!session) {
      reply.code(404)
      return { reason: 'no-session' }
    }
    return session
  })

  app.post<{ Params: { workflowId: string } }>('/api/portify/:workflowId/commit', async (req, reply) => {
    try {
      return await deps.commitPortify(req.params.workflowId)
    } catch (err) {
      reply.code((err as { statusCode?: number }).statusCode ?? 500)
      return { error: err instanceof Error ? err.message : String(err) }
    }
  })

  app.post<{ Params: { workflowId: string } }>('/api/portify/:workflowId/cancel', async (req, reply) => {
    try {
      return await deps.cancelPortify(req.params.workflowId)
    } catch (err) {
      reply.code((err as { statusCode?: number }).statusCode ?? 500)
      return { error: err instanceof Error ? err.message : String(err) }
    }
  })
}
