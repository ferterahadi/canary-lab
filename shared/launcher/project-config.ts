import fs from 'fs'
import path from 'path'

export type HealAgentChoice = 'auto' | 'claude' | 'codex' | 'manual'

export interface ProjectConfig {
  healAgent: HealAgentChoice
}

const DEFAULT: ProjectConfig = { healAgent: 'auto' }
const FILENAME = 'canary-lab.config.json'

export function projectConfigPath(projectRoot: string): string {
  return path.join(projectRoot, FILENAME)
}

function isHealAgentChoice(v: unknown): v is HealAgentChoice {
  return v === 'auto' || v === 'claude' || v === 'codex' || v === 'manual'
}

export function loadProjectConfig(projectRoot: string): ProjectConfig {
  const file = projectConfigPath(projectRoot)
  if (!fs.existsSync(file)) return { ...DEFAULT }
  try {
    const json = JSON.parse(fs.readFileSync(file, 'utf-8'))
    return {
      healAgent: isHealAgentChoice(json?.healAgent) ? json.healAgent : DEFAULT.healAgent,
    }
  } catch {
    return { ...DEFAULT }
  }
}

export function saveProjectConfig(projectRoot: string, config: ProjectConfig): void {
  const next: ProjectConfig = {
    healAgent: isHealAgentChoice(config.healAgent) ? config.healAgent : DEFAULT.healAgent,
  }
  fs.writeFileSync(projectConfigPath(projectRoot), JSON.stringify(next, null, 2) + '\n')
}
