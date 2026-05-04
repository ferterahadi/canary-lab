import fs from 'fs'
import path from 'path'

export type HealAgentChoice = 'auto' | 'claude' | 'codex' | 'manual'
export type EditorChoice = 'auto' | 'vscode' | 'cursor' | 'system'

export interface ProjectConfig {
  healAgent: HealAgentChoice
  editor: EditorChoice
}

const DEFAULT: ProjectConfig = { healAgent: 'auto', editor: 'auto' }
const FILENAME = 'canary-lab.config.json'

export function projectConfigPath(projectRoot: string): string {
  return path.join(projectRoot, FILENAME)
}

function isHealAgentChoice(v: unknown): v is HealAgentChoice {
  return v === 'auto' || v === 'claude' || v === 'codex' || v === 'manual'
}

function isEditorChoice(v: unknown): v is EditorChoice {
  return v === 'auto' || v === 'vscode' || v === 'cursor' || v === 'system'
}

export function loadProjectConfig(projectRoot: string): ProjectConfig {
  const file = projectConfigPath(projectRoot)
  if (!fs.existsSync(file)) return { ...DEFAULT }
  try {
    const json = JSON.parse(fs.readFileSync(file, 'utf-8'))
    return {
      healAgent: isHealAgentChoice(json?.healAgent) ? json.healAgent : DEFAULT.healAgent,
      editor: isEditorChoice(json?.editor) ? json.editor : DEFAULT.editor,
    }
  } catch {
    return { ...DEFAULT }
  }
}

export function saveProjectConfig(projectRoot: string, config: ProjectConfig): void {
  const next: ProjectConfig = {
    healAgent: isHealAgentChoice(config.healAgent) ? config.healAgent : DEFAULT.healAgent,
    editor: isEditorChoice(config.editor) ? config.editor : DEFAULT.editor,
  }
  fs.writeFileSync(projectConfigPath(projectRoot), JSON.stringify(next, null, 2) + '\n')
}
