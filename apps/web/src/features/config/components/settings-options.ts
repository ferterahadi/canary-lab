import type { AgentStagePlans, EditorChoice, HealAgentChoice, ModelAgentKind } from '@/shared/api/client'
import { MODEL_STAGE_KEYS, pinnedPlanEntries } from '@shared/agent-models'

// `auto` and `manual` are intentionally omitted from the settings UI (the
// server still accepts them for old config files), and `external` was retired
// entirely in 2.2.0 — external work is decided by the request's MCP origin,
// never by a workspace setting, and it runs on the client's own model setup.
export type VisibleHealAgentChoice = Extract<HealAgentChoice, 'claude' | 'codex'>

export const HEAL_AGENT_OPTIONS: { value: VisibleHealAgentChoice; label: string }[] = [
  {
    value: 'claude',
    label: 'Claude',
  },
  {
    value: 'codex',
    label: 'Codex',
  },
]

/** Shared behavior and scope belong once in the section tooltip, not beneath
 *  both agent choices and again at the bottom of the section. */
export const DEFAULT_AGENT_HELP =
  'Used for auto-heal and selected for new flights. This only affects agents started by Canary Lab. Work started by an external agent uses that agent\'s own model settings.'

// Map legacy `auto` / `manual` saved config to the shipped default (`claude`)
// for display. Saving will persist the new value, retiring it in this project.
// (The retired `external` never reaches this mirror — the server migrates it
// to `claude` on load.)
export function migrateLegacyHealAgent(value: HealAgentChoice): HealAgentChoice {
  return value === 'auto' || value === 'manual' ? 'claude' : value
}

/** One line for a customized stage plan. An untouched plan says nothing: the
 *  section already establishes that these are defaults, so repeating "agent
 *  default" beneath every choice adds height without adding information. */
export function stagePlanSummary(plans: AgentStagePlans | undefined): string | null {
  const parts = pinnedPlanEntries(plans)
  if (parts.length === 0) return null
  return parts.length === MODEL_STAGE_KEYS.length ? parts.join(' · ') : `${parts.join(' · ')} · rest agent default`
}

// The launch-gate master switch (the `askModelsOnLaunch` config field). One
// boolean, so it renders as one CHECKBOX row rather than two radios — the same
// shape as the dialog's other two standalone on/off settings (Onboarding,
// auto-PR). The pair it replaced spent four lines and a second card header
// saying what "on" and "off" mean; the description carries both now.
export const ASK_ON_LAUNCH_LABEL = 'Ask before launch'

export const ASK_ON_LAUNCH_DESCRIPTION =
  'Pauses each launch to review or change models. Unchecked, launches start with your saved models.'

/** Secondary launch scope stays discoverable without repeating it in both
 *  choices. */
export const ASK_ON_LAUNCH_HELP =
  'Applies to flights, suite runs, and coverage jobs. Model changes made at launch apply to that launch only.'

export function agentTitle(agent: ModelAgentKind): string {
  return agent === 'claude' ? 'Claude' : 'Codex'
}

export type VisibleEditorChoice = Exclude<EditorChoice, 'system'>

export const EDITOR_OPTIONS: { value: VisibleEditorChoice; label: string; description: string }[] = [
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
]

/** Older servers can still return the retired saved preference. Display it as
 *  Auto-detect so the radio group always has a live choice; saving persists the
 *  new meaning. */
export function migrateLegacyEditor(editor: EditorChoice): VisibleEditorChoice {
  return editor === 'system' ? 'auto' : editor
}

/** Human name for an editor choice — `vscode` is a command id, not something to
 *  show a user. Read by any surface that reports which editor it launched. */
export function editorLabel(editor: string): string {
  if (editor === 'system') return 'System default'
  return EDITOR_OPTIONS.find((o) => o.value === editor)?.label ?? editor
}

/** What the wiki folder IS stays on the card; what auto-heal does with it goes
 *  behind the help icon — the same split Port and the agent section use, so
 *  every card in the dialog opens with one short line rather than one card in
 *  three opening with a paragraph. */
export const WIKI_SUMMARY = 'Optional folder of distilled agent notes.'

export const WIKI_HELP =
  'A Karpathy-style personal wiki. Auto-heal receives the path and reads only the notes relevant to the failure it is repairing.'

/** One in-card TEXT action (Change port, Restart anyway). These had drifted to
 *  three sizes across the dialog's cards, so the same kind of action looked
 *  different depending on where it landed. Two other in-card actions are now
 *  icons instead — the agent rows' configure gear and the GitHub re-check —
 *  and those share `.cl-icon-button h-6 w-6`. The dialog's FOOTER actions keep
 *  their own wider size: Close and Save commit the whole dialog, not one card. */
export const SETTINGS_ACTION_CLASS = 'cl-button px-2.5 py-1 text-xs'

export const DEFAULT_PORT = 7421

export const PORT_SUMMARY = `Used by the UI and MCP server. Default: ${DEFAULT_PORT}.`

export const PORT_HELP =
  'Changing the port restarts Canary Lab. If your MCP client does not reconnect, restart it or toggle the connector.'

export function parsePort(origin: string): number | null {
  try {
    const p = Number(new URL(origin).port)
    return Number.isFinite(p) && p > 0 ? p : null
  } catch {
    return null
  }
}
