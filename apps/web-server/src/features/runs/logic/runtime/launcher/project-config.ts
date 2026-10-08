import { atomicWriteJson } from '../../../../../../../../shared/lib/atomic-write'
import type { ProjectConfig, HealAgentChoice, EditorChoice } from '../../../../../../../../shared/project-config'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { normalizeAgentModels } from '../../../../../../../../shared/agent-models'

// Default to `claude` — GUI-started runs self-heal internally. `auto`/`manual`
// are still accepted by the validator for backwards compatibility with older
// configs; MCP-origin runs park for the external client regardless of this.
const DEFAULT: ProjectConfig = { healAgent: 'claude', editor: 'auto', agentModels: { claude: {}, codex: {} }, askModelsOnLaunch: false, personalWikiPath: null, autoProposePr: true, showDemo: true }
const FILENAME = 'canary-lab.config.json'

// The historical fixed port. Used whenever a project does not pin its own.
export const DEFAULT_PORT = 7421

export function isValidPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535
}

export function normalizePort(value: unknown): number | undefined {
  return isValidPort(value) ? value : undefined
}

export function resolveProjectPort(config: ProjectConfig): number {
  return config.port ?? DEFAULT_PORT
}

export function projectConfigPath(projectRoot: string): string {
  return path.join(projectRoot, FILENAME)
}

function isHealAgentChoice(v: unknown): v is HealAgentChoice {
  return v === 'auto' || v === 'claude' || v === 'codex' || v === 'manual'
}

/** A usable heal-agent value out of untrusted input, or undefined. The retired
 *  `external` maps to `claude` silently (2.2.0 migration) so old config files
 *  and old clients keep working without a notice. */
export function normalizeHealAgent(v: unknown): HealAgentChoice | undefined {
  if (v === 'external') return 'claude'
  return isHealAgentChoice(v) ? v : undefined
}

function isEditorChoice(v: unknown): v is EditorChoice {
  return v === 'auto' || v === 'vscode' || v === 'cursor' || v === 'system'
}

/** `system` used to be a saved preference. It now belongs to auto-detection as
 *  the final fallback, so old config files and clients migrate to `auto` while
 *  launch results can still report that the system opener was actually used. */
export function normalizeEditor(v: unknown): EditorChoice | undefined {
  if (v === 'system') return 'auto'
  return isEditorChoice(v) ? v : undefined
}

export function normalizePersonalWikiPath(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  const expanded = expandHome(trimmed)
  if (!path.isAbsolute(expanded)) return null
  try {
    const resolved = fs.realpathSync(expanded)
    return fs.statSync(resolved).isDirectory() ? resolved : null
  } catch {
    return null
  }
}

function expandHome(value: string): string {
  if (value === '~') return os.homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return path.join(os.homedir(), value.slice(2))
  }
  return value
}

export function loadProjectConfig(projectRoot: string): ProjectConfig {
  const file = projectConfigPath(projectRoot)
  if (!fs.existsSync(file)) return { ...DEFAULT }
  try {
    const json = JSON.parse(fs.readFileSync(file, 'utf-8'))
    const port = normalizePort(json?.port)
    return {
      healAgent: normalizeHealAgent(json?.healAgent) ?? DEFAULT.healAgent,
      editor: normalizeEditor(json?.editor) ?? DEFAULT.editor,
      agentModels: normalizeAgentModels(json?.agentModels),
      askModelsOnLaunch: json?.askModelsOnLaunch === true,
      personalWikiPath: normalizePersonalWikiPath(json?.personalWikiPath),
      autoProposePr: json?.autoProposePr !== false,
      showDemo: json?.showDemo !== false,
      ...(port === undefined ? {} : { port }),
    }
  } catch {
    return { ...DEFAULT }
  }
}

export function saveProjectConfig(projectRoot: string, config: ProjectConfig): void {
  const port = normalizePort(config.port)
  const next: ProjectConfig = {
    healAgent: normalizeHealAgent(config.healAgent) ?? DEFAULT.healAgent,
    editor: normalizeEditor(config.editor) ?? DEFAULT.editor,
    agentModels: normalizeAgentModels(config.agentModels),
    askModelsOnLaunch: config.askModelsOnLaunch === true,
    personalWikiPath: normalizePersonalWikiPath(config.personalWikiPath),
    autoProposePr: config.autoProposePr !== false,
    showDemo: config.showDemo !== false,
    ...(port === undefined ? {} : { port }),
  }
  atomicWriteJson(projectConfigPath(projectRoot), next, undefined, { uniqueTemporary: true, followSymlinks: true, createParents: false })
}
