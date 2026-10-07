import type { EditorChoice, HealAgentChoice, ProjectConfig } from '../../../../../../shared/project-config'
import type { FastifyInstance } from 'fastify'
import fs from 'fs'
import path from 'path'
import { launchSystemTarget } from '../../../shared/system-launch'
import { launchEditor, launchEditorDir } from '../../../shared/editor-launch'
import { publishWorkspaceEvent, type WorkspaceEventPublisher } from '../../../shared/workspace-events'
import {
  isValidPort,
  loadProjectConfig,
  normalizeEditor,
  normalizeHealAgent,
  normalizePersonalWikiPath,
  resolveProjectPort,
  saveProjectConfig,
} from '../../runs/logic/runtime/launcher/project-config'
import { normalizeAgentModels } from '../../../../../../shared/agent-models'
import { isWithin } from '../logic/path-containment'
import { notFound } from '../../../shared/http-error'

export interface ProjectConfigRouteDeps {
  projectRoot: string
  // Count of in-flight runs a restart would abort. Used to gate port changes.
  countActiveRuns?: () => number
  // Invoked after a port change is persisted; the host process relaunches the
  // UI on the new port and shuts the current one down. Fire-and-forget — the
  // host defers the actual restart so the HTTP response can flush first.
  onPortChange?: (port: number) => void | Promise<void>
  // Announces a persisted config write so every open client refetches. Optional
  // (absent in tests, real bus in server.ts) like every other route's.
  workspaceEvents?: WorkspaceEventPublisher
}

const HEAL_AGENT_VALUES: HealAgentChoice[] = ['auto', 'claude', 'codex', 'manual']
const EDITOR_VALUES: EditorChoice[] = ['auto', 'vscode', 'cursor', 'system']

export async function projectConfigRoutes(
  app: FastifyInstance,
  deps: ProjectConfigRouteDeps,
): Promise<void> {
  app.get('/api/project-config', async () => {
    return loadProjectConfig(deps.projectRoot)
  })

  app.put<{ Body: Partial<ProjectConfig> }>('/api/project-config', async (req, reply) => {
    // Normalized rather than membership-checked: retired choices map to their
    // current meanings, so a stale client's PUT keeps working.
    const incomingHealAgent = req.body?.healAgent === undefined
      ? undefined
      : normalizeHealAgent(req.body.healAgent)
    const incomingEditor = req.body?.editor === undefined
      ? undefined
      : normalizeEditor(req.body.editor)
    const incomingPersonalWikiPath = req.body?.personalWikiPath
    if (req.body?.healAgent !== undefined && incomingHealAgent === undefined) {
      reply.code(400)
      return { error: `healAgent must be one of: ${HEAL_AGENT_VALUES.join(', ')}` }
    }
    if (req.body?.editor !== undefined && incomingEditor === undefined) {
      reply.code(400)
      return { error: `editor must be one of: ${EDITOR_VALUES.join(', ')}` }
    }
    const personalWikiPath = normalizeIncomingPersonalWikiPath(incomingPersonalWikiPath)
    if (personalWikiPath === undefined && incomingPersonalWikiPath !== undefined) {
      reply.code(400)
      return { error: 'personalWikiPath must be an existing directory path, null, or empty string' }
    }
    const incomingAutoProposePr = req.body?.autoProposePr
    if (incomingAutoProposePr !== undefined && typeof incomingAutoProposePr !== 'boolean') {
      reply.code(400)
      return { error: 'autoProposePr must be a boolean' }
    }
    const incomingShowDemo = req.body?.showDemo
    if (incomingShowDemo !== undefined && typeof incomingShowDemo !== 'boolean') {
      reply.code(400)
      return { error: 'showDemo must be a boolean' }
    }
    const incomingAskModels = req.body?.askModelsOnLaunch
    if (incomingAskModels !== undefined && typeof incomingAskModels !== 'boolean') {
      reply.code(400)
      return { error: 'askModelsOnLaunch must be a boolean' }
    }
    // agentModels is normalized rather than rejected: unknown stages and
    // invalid efforts drop out, and whatever survives is exactly what a spawn
    // would resolve. A shape so broken it normalizes to empty is still a valid
    // "everything agent default" plan.
    const incomingAgentModels = req.body?.agentModels === undefined
      ? undefined
      : normalizeAgentModels(req.body.agentModels)
    const current = loadProjectConfig(deps.projectRoot)
    const next: ProjectConfig = {
      healAgent: incomingHealAgent ?? current.healAgent,
      editor: incomingEditor ?? current.editor,
      agentModels: incomingAgentModels ?? current.agentModels,
      askModelsOnLaunch: incomingAskModels ?? current.askModelsOnLaunch,
      personalWikiPath: incomingPersonalWikiPath !== undefined
        ? personalWikiPath!
        : current.personalWikiPath,
      autoProposePr: incomingAutoProposePr ?? current.autoProposePr,
      showDemo: incomingShowDemo ?? current.showDemo,
      // Carried, never accepted from the body: the port is owned by
      // POST /api/project-config/port, which rebinds the server as it saves.
      // Rebuilding the config without it drops a pinned port silently — the
      // file is not reread until the next boot, which then lands on
      // DEFAULT_PORT and strands every client aimed at the pinned one.
      ...(current.port === undefined ? {} : { port: current.port }),
    }
    saveProjectConfig(deps.projectRoot, next)
    // After the write, never before: a failed save must not announce a change.
    publishWorkspaceEvent(deps.workspaceEvents, { type: 'project-config-changed' })
    return next
  })

  // ─── port change (restarts the UI on a new port) ─────────────────────
  app.post<{ Body: { port?: number; confirm?: boolean } }>('/api/project-config/port', async (req, reply) => {
    const port = req.body?.port
    if (!isValidPort(port)) {
      reply.code(400)
      return { error: 'port must be an integer between 1 and 65535' }
    }
    const current = loadProjectConfig(deps.projectRoot)
    if (resolveProjectPort(current) === port) {
      return { restarting: false, port, reason: 'unchanged' as const }
    }
    const activeRuns = deps.countActiveRuns?.() ?? 0
    if (activeRuns > 0 && req.body?.confirm !== true) {
      reply.code(409)
      return { needsConfirm: true, activeRuns }
    }
    saveProjectConfig(deps.projectRoot, { ...current, port })
    // Fire-and-forget: the host process owns the relaunch + self-shutdown and
    // defers it so this response reaches the browser before the port flips.
    void deps.onPortChange?.(port)
    return { restarting: true, port, newOrigin: `http://localhost:${port}` }
  })

  // ─── desktop-app launcher ─────────────────────────────────────────────
  // Used by the manual heal-mode banner: a one-click way to surface the
  // user's installed Claude or Codex desktop app. Best-effort by platform —
  // returns 200 even when the open command fails so the UI stays simple
  // (the user can always launch the app themselves).

  app.post<{ Body: { agent: 'claude' | 'codex' } }>('/api/open-agent', async (req, reply) => {
    const agent = req.body?.agent
    if (agent !== 'claude' && agent !== 'codex') {
      reply.code(400)
      return { error: 'agent must be "claude" or "codex"' }
    }
    try {
      launchSystemTarget({ kind: 'application', agent })
      return { opened: true }
    } catch (err) {
      reply.code(500)
      return { error: (err as Error).message }
    }
  })

  // ─── workspace-root launcher ──────────────────────────────────────────
  // Opens the whole project root in the configured editor — same launcher
  // runs.ts's worktree-open route uses for a single worktree dir.
  app.post('/api/open-workspace', async (_req, reply) => {
    const editor = loadProjectConfig(deps.projectRoot).editor
    try {
      const usedEditor = launchEditorDir(editor, deps.projectRoot)
      return { opened: true, path: deps.projectRoot, editor: usedEditor }
    } catch (err) {
      reply.code(200)
      return { opened: false, path: deps.projectRoot, error: err instanceof Error ? err.message : String(err) }
    }
  })

  app.post<{
    Body: { file?: string; line?: number; column?: number; editor?: EditorChoice }
  }>('/api/open-editor', async (req, reply) => {
    const body = req.body ?? {}
    const file = body.file
    if (!file || typeof file !== 'string') {
      reply.code(400)
      return { error: 'file is required' }
    }
    if (!path.isAbsolute(file)) {
      reply.code(400)
      return { error: 'file must be absolute' }
    }
    if (body.editor !== undefined && !EDITOR_VALUES.includes(body.editor)) {
      reply.code(400)
      return { error: `editor must be one of: ${EDITOR_VALUES.join(', ')}` }
    }
    const line = normalPositiveInt(body.line, 1)
    const column = normalPositiveInt(body.column, 1)

    let resolvedFile: string
    let resolvedRoot: string
    try {
      resolvedRoot = fs.realpathSync(deps.projectRoot)
      resolvedFile = fs.realpathSync(file)
      const stat = fs.statSync(resolvedFile)
      if (!stat.isFile()) {
        reply.code(400)
        return { error: 'file must be a file' }
      }
    } catch {
      return notFound(reply, 'file')
    }

    // Linked project files may live elsewhere. Authorize the project entry path,
    // then launch its real target; an unrelated outside path is still rejected.
    const projectEntry = isWithin(deps.projectRoot, file)
      || isWithin(resolvedRoot, file)
    if (!projectEntry && !isWithin(resolvedRoot, resolvedFile)) {
      reply.code(400)
      return { error: 'file must be inside the project root' }
    }

    const configured = loadProjectConfig(deps.projectRoot).editor
    const editor = body.editor ?? configured
    try {
      const openedBy = launchEditor(editor, { kind: 'file', path: resolvedFile, line, column })
      return { opened: true, editor: openedBy }
    } catch (err) {
      reply.code(500)
      return { error: (err as Error).message }
    }
  })
}

function normalizeIncomingPersonalWikiPath(value: unknown): string | null | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  if (typeof value !== 'string') return undefined
  if (value.trim() === '') return null
  return normalizePersonalWikiPath(value) ?? undefined
}

function normalPositiveInt(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback
}
