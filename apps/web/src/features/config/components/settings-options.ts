import type { AgentStagePlans, EditorChoice, HealAgentChoice, ModelAgentKind } from '@/shared/api/client'
import { MODEL_STAGE_KEYS, pinnedPlanEntries } from '@shared/agent-models'

// `auto` and `manual` are intentionally omitted from the settings UI (the
// server still accepts them for old config files), and `external` was retired
// entirely in 2.2.0 — external work is decided by the request's MCP origin,
// never by a workspace setting, and it runs on the client's own model setup.
export type VisibleHealAgentChoice = Extract<HealAgentChoice, 'claude' | 'codex'>

export const HEAL_AGENT_OPTIONS: { value: VisibleHealAgentChoice; label: string; description: string }[] = [
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

// Map legacy `auto` / `manual` saved config to the shipped default (`claude`)
// for display. Saving will persist the new value, retiring it in this project.
// (The retired `external` never reaches this mirror — the server migrates it
// to `claude` on load.)
export function migrateLegacyHealAgent(value: HealAgentChoice): HealAgentChoice {
  return value === 'auto' || value === 'manual' ? 'claude' : value
}

/** One line saying what an agent's stage plans amount to — pinned stages in
 *  front, "rest agent default" behind — so the settings dialog answers "what
 *  will this run on?" without opening the matrix. */
export function stagePlanSummary(plans: AgentStagePlans | undefined): string {
  const parts = pinnedPlanEntries(plans)
  if (parts.length === 0) return 'All stages agent default'
  return parts.length === MODEL_STAGE_KEYS.length ? parts.join(' · ') : `${parts.join(' · ')} · rest agent default`
}

/** The launch-gate master switch (the `askModelsOnLaunch` config field). */
export const ASK_ON_LAUNCH_OPTIONS: { value: boolean; label: string; description: string }[] = [
  {
    value: false,
    label: 'Use defaults silently',
    description: 'Every launch runs on the per-stage defaults configured above.',
  },
  {
    value: true,
    label: 'Ask at every launch',
    description: 'Starting a flight, suite run, or coverage job first offers: use the defaults, or customize models for that launch only.',
  },
]

/** Copy shared by the settings hint and the chip tooltip: what this section
 *  does and does not govern. */
export const INTERNAL_AGENTS_ONLY_COPY =
  'Applies to the agents Canary Lab spawns itself — heal, flight stages, coverage, portify. Work driven by an external agent over MCP uses the model configured in that client; these settings never touch it.'

export function agentTitle(agent: ModelAgentKind): string {
  return agent === 'claude' ? 'Claude' : 'Codex'
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

/** Human name for an editor choice — `vscode` is a command id, not something to
 *  show a user. Read by any surface that reports which editor it launched. */
export function editorLabel(editor: string): string {
  return EDITOR_OPTIONS.find((o) => o.value === editor)?.label ?? editor
}

export const DEFAULT_PORT = 7421

export function parsePort(origin: string): number | null {
  try {
    const p = Number(new URL(origin).port)
    return Number.isFinite(p) && p > 0 ? p : null
  } catch {
    return null
  }
}
