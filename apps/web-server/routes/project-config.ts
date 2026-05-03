import type { FastifyInstance } from 'fastify'
import { spawn } from 'child_process'
import {
  loadProjectConfig,
  saveProjectConfig,
  type HealAgentChoice,
  type ProjectConfig,
} from '../lib/runtime/launcher/project-config'

export interface ProjectConfigRouteDeps {
  projectRoot: string
}

const HEAL_AGENT_VALUES: HealAgentChoice[] = ['auto', 'claude', 'codex', 'manual']

export async function projectConfigRoutes(
  app: FastifyInstance,
  deps: ProjectConfigRouteDeps,
): Promise<void> {
  app.get('/api/project-config', async () => {
    return loadProjectConfig(deps.projectRoot)
  })

  app.put<{ Body: Partial<ProjectConfig> }>('/api/project-config', async (req, reply) => {
    const incoming = req.body?.healAgent
    if (incoming !== undefined && !HEAL_AGENT_VALUES.includes(incoming)) {
      reply.code(400)
      return { error: `healAgent must be one of: ${HEAL_AGENT_VALUES.join(', ')}` }
    }
    const current = loadProjectConfig(deps.projectRoot)
    const next: ProjectConfig = {
      healAgent: incoming ?? current.healAgent,
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
}
