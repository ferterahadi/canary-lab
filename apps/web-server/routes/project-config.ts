import type { FastifyInstance } from 'fastify'
import fs from 'fs'
import path from 'path'
import { spawn, spawnSync } from 'child_process'
import {
  loadProjectConfig,
  saveProjectConfig,
  type EditorChoice,
  type HealAgentChoice,
  type ProjectConfig,
} from '../lib/runtime/launcher/project-config'

export interface ProjectConfigRouteDeps {
  projectRoot: string
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
    const incomingHealAgent = req.body?.healAgent
    const incomingEditor = req.body?.editor
    if (incomingHealAgent !== undefined && !HEAL_AGENT_VALUES.includes(incomingHealAgent)) {
      reply.code(400)
      return { error: `healAgent must be one of: ${HEAL_AGENT_VALUES.join(', ')}` }
    }
    if (incomingEditor !== undefined && !EDITOR_VALUES.includes(incomingEditor)) {
      reply.code(400)
      return { error: `editor must be one of: ${EDITOR_VALUES.join(', ')}` }
    }
    const current = loadProjectConfig(deps.projectRoot)
    const next: ProjectConfig = {
      healAgent: incomingHealAgent ?? current.healAgent,
      editor: incomingEditor ?? current.editor,
    }
    saveProjectConfig(deps.projectRoot, next)
    return next
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
