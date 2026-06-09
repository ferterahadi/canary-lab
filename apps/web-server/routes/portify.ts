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
  revisePortify(workflowId: string, feedback: string): Promise<PortifyManifest>
  removePortify(workflowId: string): Promise<{ workflowId: string; removed: true }>
  loadAgentSession(workflowId: string): { agent: string; sessionId: string; model?: string; effort?: string; events: unknown[] } | null
}

interface StartBody {
  feature?: string
  agent?: string
  maxAttempts?: number
}

interface ReviseBody {
  feedback?: string
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

  // Remove a finished workflow from history. Terminal-only (the runner guards).
  app.delete<{ Params: { workflowId: string } }>('/api/portify/:workflowId', async (req, reply) => {
    try {
      return await deps.removePortify(req.params.workflowId)
    } catch (err) {
      reply.code((err as { statusCode?: number }).statusCode ?? 500)
      return { error: err instanceof Error ? err.message : String(err) }
    }
  })

  // Resume the agent with the reviewer's feedback (revise pass). The workflow
  // cycles back through editing → verifying → ready-to-commit; the wizard polls.
  app.post<{ Params: { workflowId: string }; Body: ReviseBody }>('/api/portify/:workflowId/revise', async (req, reply) => {
    const feedback = typeof req.body?.feedback === 'string' ? req.body.feedback.trim() : ''
    if (!feedback) {
      reply.code(400)
      return { error: 'feedback is required' }
    }
    try {
      return await deps.revisePortify(req.params.workflowId, feedback)
    } catch (err) {
      reply.code((err as { statusCode?: number }).statusCode ?? 500)
      return { error: err instanceof Error ? err.message : String(err) }
    }
  })
}
