import fs from 'fs'
import type { FastifyInstance } from 'fastify'
import type { PortifyStore } from '../../portify/logic/runtime/store'
import type { PortifyManifest, StartPortifyInput, StartPortifyResult } from '../../portify/logic/runtime/types'
import type { HealAgent } from '../../runs/logic/runtime/auto-heal'
import { publishWorkspaceEvent, type WorkspaceEventPublisher } from '../../../shared/workspace-events'
import { launchEditorDir } from '../../../shared/editor-launch'
import { loadProjectConfig, type EditorChoice } from '../../runs/logic/runtime/launcher/project-config'

// REST surface for the port-ification workflow, mirroring routes/benchmarks.ts.
// Reads go through the injected store; start/save/cancel delegate to the
// injected runner. The wizard polls GET /api/portify/:id for live status.

export interface PortifyRouteDeps {
  store: PortifyStore
  startPortify(input: StartPortifyInput): Promise<StartPortifyResult>
  savePortify(workflowId: string): Promise<PortifyManifest>
  cancelPortify(workflowId: string): Promise<PortifyManifest>
  revisePortify(workflowId: string, feedback: string): Promise<PortifyManifest>
  removePortify(workflowId: string): Promise<{ workflowId: string; removed: true }>
  loadAgentSession(workflowId: string): { agent: string; sessionId: string; model?: string; effort?: string; events: unknown[] } | null
  workspaceEvents?: WorkspaceEventPublisher
  /** Product root — resolves the configured editor for "open in editor". */
  projectRoot?: string
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

  // Open the port-ification project in the user's editor. While the workflow is
  // live the scratch worktree(s) hold the edits; once saved they're discarded,
  // so fall back to the product repo. Best-effort, mirroring the benchmark/run
  // worktree openers — a failed launch reports the path so the UI can fall back.
  app.post<{ Params: { workflowId: string } }>('/api/portify/:workflowId/open', async (req, reply) => {
    const manifest = deps.store.get(req.params.workflowId)
    if (!manifest) {
      reply.code(404)
      return { error: 'workflow not found' }
    }
    const dirs: string[] = []
    for (const repo of manifest.repos) {
      const dir = repo.worktreePath && fs.existsSync(repo.worktreePath) ? repo.worktreePath : repo.path
      if (dir && fs.existsSync(dir) && !dirs.includes(dir)) dirs.push(dir)
    }
    if (dirs.length === 0) {
      reply.code(409)
      return { error: 'no project directory is available to open' }
    }
    const editor: EditorChoice = deps.projectRoot ? loadProjectConfig(deps.projectRoot).editor : 'auto'
    try {
      let usedEditor: EditorChoice = editor
      for (const dir of dirs) usedEditor = launchEditorDir(editor, dir)
      return { opened: true, paths: dirs, editor: usedEditor }
    } catch (err) {
      reply.code(200)
      return { opened: false, paths: dirs, error: err instanceof Error ? err.message : String(err) }
    }
  })

  app.get<{ Params: { workflowId: string } }>('/api/portify/:workflowId/agent-session', async (req, reply) => {
    const session = deps.loadAgentSession(req.params.workflowId)
    if (!session) {
      reply.code(404)
      return { reason: 'no-session' }
    }
    return session
  })

  // Save the verified edits as the feature's ephemeral overlay (replaces the
  // old commit/merge). The scratch worktree is discarded; nothing lands in the
  // product repo.
  app.post<{ Params: { workflowId: string } }>('/api/portify/:workflowId/save', async (req, reply) => {
    try {
      const manifest = await deps.savePortify(req.params.workflowId)
      publishWorkspaceEvent(deps.workspaceEvents, { type: 'features-changed' })
      return manifest
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
  // cycles back through editing → verifying → ready-to-save; the wizard polls.
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
