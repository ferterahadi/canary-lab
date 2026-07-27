import type { EditorChoice, HealAgentChoice } from '@/shared/api/client'

// `auto` and `manual` are intentionally omitted from the settings UI. The
// server still accepts them for old config files and run-level compatibility,
// but the modern project-level choice is external client ownership.
export type VisibleHealAgentChoice = Extract<HealAgentChoice, 'external' | 'claude' | 'codex'>

export const HEAL_AGENT_OPTIONS: { value: VisibleHealAgentChoice; label: string; description: string }[] = [
  {
    value: 'external',
    label: 'External client',
    description: 'Let Claude / Codex Desktop or CLI drive heal over MCP. Canary Lab waits for that client to claim and signal. New flights default to Claude.',
  },
  {
    value: 'claude',
    label: 'Claude',
    description: 'Always use the `claude` CLI for auto-heal, and preselect it for new flights.',
  },
  {
    value: 'codex',
    label: 'Codex',
    description: 'Always use the `codex` CLI for auto-heal, and preselect it for new flights.',
  },
]

// Map legacy `auto` / `manual` saved config to the new default (`external`) for
// display. Saving will persist the new value, retiring it in this project.
export function migrateLegacyHealAgent(value: HealAgentChoice): HealAgentChoice {
  return value === 'auto' || value === 'manual' ? 'external' : value
}

export const EDITOR_OPTIONS: { value: EditorChoice; label: string; description: string }[] = [
  {
    value: 'auto',
    label: 'Auto-detect',
    description: 'Prefer Cursor, then VS Code, then the system default.',
  },
  {
    value: 'cursor',
    label: 'Cursor',
    description: 'Open files with `cursor -g`.',
  },
  {
    value: 'vscode',
    label: 'VS Code',
    description: 'Open files with `code -g`.',
  },
  {
    value: 'system',
    label: 'System default',
    description: 'Open files with the operating system default app.',
  },
]

export const DEFAULT_PORT = 7421

export function parsePort(origin: string): number | null {
  try {
    const p = Number(new URL(origin).port)
    return Number.isFinite(p) && p > 0 ? p : null
  } catch {
    return null
  }
}
