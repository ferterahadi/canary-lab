import type { FastifyInstance } from 'fastify'
import fs from 'fs'
import path from 'path'
import { spawn, spawnSync } from 'child_process'
import { launchEditorDir } from '../../../shared/editor-launch'
import {
  isValidPort,
  loadProjectConfig,
  normalizePersonalWikiPath,
  resolveProjectPort,
  saveProjectConfig,
  type EditorChoice,
  type HealAgentChoice,
  type ProjectConfig,
} from '../../runs/logic/runtime/launcher/project-config'

export interface ProjectConfigRouteDeps {
  projectRoot: string
  // Count of in-flight runs a restart would abort. Used to gate port changes.
  countActiveRuns?: () => number
  // Invoked after a port change is persisted; the host process relaunches the
  // UI on the new port and shuts the current one down. Fire-and-forget — the
  // host defers the actual restart so the HTTP response can flush first.
  onPortChange?: (port: number) => void | Promise<void>
}

const HEAL_AGENT_VALUES: HealAgentChoice[] = ['auto', 'claude', 'codex', 'manual', 'external']
const EDITOR_VALUES: EditorChoice[] = ['auto', 'vscode', 'cursor', 'system']

export async function projectConfigRoutes(
  app: FastifyInstance,
  deps: ProjectConfigRouteDeps,
): Promise<void> {
  app.get('/api/project-config', async () => {
    return loadProjectConfig(deps.projectRoot)
  })

  app.put<{ Body: Partial<ProjectConfig> }>('/api/project-config', async (req, reply) => {
    const incomingHealAgent = req.body?.healAgent
    const incomingEditor = req.body?.editor
    const incomingPersonalWikiPath = req.body?.personalWikiPath
    if (incomingHealAgent !== undefined && !HEAL_AGENT_VALUES.includes(incomingHealAgent)) {
      reply.code(400)
      return { error: `healAgent must be one of: ${HEAL_AGENT_VALUES.join(', ')}` }
    }
    if (incomingEditor !== undefined && !EDITOR_VALUES.includes(incomingEditor)) {
      reply.code(400)
      return { error: `editor must be one of: ${EDITOR_VALUES.join(', ')}` }
    }
    const personalWikiPath = normalizeIncomingPersonalWikiPath(incomingPersonalWikiPath)
    if (personalWikiPath === undefined && incomingPersonalWikiPath !== undefined) {
      reply.code(400)
      return { error: 'personalWikiPath must be an existing directory path, null, or empty string' }
    }
    const current = loadProjectConfig(deps.projectRoot)
    const next: ProjectConfig = {
      healAgent: incomingHealAgent ?? current.healAgent,
      editor: incomingEditor ?? current.editor,
      personalWikiPath: incomingPersonalWikiPath !== undefined
        ? personalWikiPath!
        : current.personalWikiPath,
    }
    saveProjectConfig(deps.projectRoot, next)
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
    const appName = agent === 'claude' ? 'Claude' : 'Codex'
    try {
      if (process.platform === 'darwin') {
        spawn('open', ['-a', appName], { stdio: 'ignore', detached: true }).unref()
      } else if (process.platform === 'win32') {
        spawn('cmd', ['/c', 'start', '', appName], { stdio: 'ignore', detached: true }).unref()
      } else {
        spawn(appName.toLowerCase(), [], { stdio: 'ignore', detached: true }).unref()
      }
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
      reply.code(404)
      return { error: 'file not found' }
    }

    if (!isInside(resolvedFile, resolvedRoot)) {
      reply.code(400)
      return { error: 'file must be inside the project root' }
    }

    const configured = loadProjectConfig(deps.projectRoot).editor
    const editor = body.editor ?? configured
    try {
      const openedBy = launchEditor({ editor, file: resolvedFile, line, column })
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

function isInside(file: string, root: string): boolean {
  const rel = path.relative(root, file)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

function launchEditor(input: {
  editor: EditorChoice
  file: string
  line: number
  column: number
}): EditorChoice {
  if (input.editor === 'auto') {
    if (commandExists('cursor')) return launchCliEditor('cursor', input)
    if (commandExists('code')) return launchCliEditor('code', input)
    return launchSystem(input.file)
  }
  if (input.editor === 'cursor') return launchCliEditor('cursor', input)
  if (input.editor === 'vscode') return launchCliEditor('code', input)
  return launchSystem(input.file)
}

function commandExists(command: string): boolean {
  const lookup = process.platform === 'win32' ? 'where' : 'which'
  const result = spawnSync(lookup, [command], { stdio: 'ignore' })
  return result.status === 0
}

function launchCliEditor(
  command: 'code' | 'cursor',
  input: { file: string; line: number; column: number },
): EditorChoice {
  spawn(command, ['-g', `${input.file}:${input.line}:${input.column}`], {
    stdio: 'ignore',
    detached: true,
  }).unref()
  return command === 'code' ? 'vscode' : 'cursor'
}

function launchSystem(file: string): 'system' {
  if (process.platform === 'darwin') {
    spawn('open', [file], { stdio: 'ignore', detached: true }).unref()
  } else if (process.platform === 'win32') {
    spawn('cmd', ['/c', 'start', '', file], { stdio: 'ignore', detached: true }).unref()
  } else {
    spawn('xdg-open', [file], { stdio: 'ignore', detached: true }).unref()
  }
  return 'system'
}
