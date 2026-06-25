import fs from 'fs'
import os from 'os'
import path from 'path'

export type HealAgentChoice = 'auto' | 'claude' | 'codex' | 'manual' | 'external'
export type EditorChoice = 'auto' | 'vscode' | 'cursor' | 'system'

export interface ProjectConfig {
  healAgent: HealAgentChoice
  editor: EditorChoice
  personalWikiPath: string | null
  /** Localhost port for the UI + MCP HTTP server. Absent → DEFAULT_PORT. */
  port?: number
}

// Default to `external` — the modern Claude/Codex via MCP flow. `auto` is
// still accepted by the validator for backwards compatibility with older
// configs, but new installs and the settings UI prefer external.
const DEFAULT: ProjectConfig = { healAgent: 'external', editor: 'auto', personalWikiPath: null }
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
  return (
    v === 'auto' ||
    v === 'claude' ||
    v === 'codex' ||
    v === 'manual' ||
    v === 'external'
  )
}

function isEditorChoice(v: unknown): v is EditorChoice {
  return v === 'auto' || v === 'vscode' || v === 'cursor' || v === 'system'
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
      healAgent: isHealAgentChoice(json?.healAgent) ? json.healAgent : DEFAULT.healAgent,
      editor: isEditorChoice(json?.editor) ? json.editor : DEFAULT.editor,
      personalWikiPath: normalizePersonalWikiPath(json?.personalWikiPath),
      ...(port === undefined ? {} : { port }),
    }
  } catch {
    return { ...DEFAULT }
  }
}

export function saveProjectConfig(projectRoot: string, config: ProjectConfig): void {
  const port = normalizePort(config.port)
  const next: ProjectConfig = {
    healAgent: isHealAgentChoice(config.healAgent) ? config.healAgent : DEFAULT.healAgent,
    editor: isEditorChoice(config.editor) ? config.editor : DEFAULT.editor,
    personalWikiPath: normalizePersonalWikiPath(config.personalWikiPath),
    ...(port === undefined ? {} : { port }),
  }
  fs.writeFileSync(projectConfigPath(projectRoot), JSON.stringify(next, null, 2) + '\n')
}
