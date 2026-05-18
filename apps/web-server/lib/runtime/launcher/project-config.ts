import fs from 'fs'
import os from 'os'
import path from 'path'

export type HealAgentChoice = 'auto' | 'claude' | 'codex' | 'manual' | 'external'
export type EditorChoice = 'auto' | 'vscode' | 'cursor' | 'system'

export interface ProjectConfig {
  healAgent: HealAgentChoice
  editor: EditorChoice
  personalWikiPath: string | null
}

const DEFAULT: ProjectConfig = { healAgent: 'auto', editor: 'auto', personalWikiPath: null }
const FILENAME = 'canary-lab.config.json'

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
    return {
      healAgent: isHealAgentChoice(json?.healAgent) ? json.healAgent : DEFAULT.healAgent,
      editor: isEditorChoice(json?.editor) ? json.editor : DEFAULT.editor,
      personalWikiPath: normalizePersonalWikiPath(json?.personalWikiPath),
    }
  } catch {
    return { ...DEFAULT }
  }
}

export function saveProjectConfig(projectRoot: string, config: ProjectConfig): void {
  const next: ProjectConfig = {
    healAgent: isHealAgentChoice(config.healAgent) ? config.healAgent : DEFAULT.healAgent,
    editor: isEditorChoice(config.editor) ? config.editor : DEFAULT.editor,
    personalWikiPath: normalizePersonalWikiPath(config.personalWikiPath),
  }
  fs.writeFileSync(projectConfigPath(projectRoot), JSON.stringify(next, null, 2) + '\n')
}
