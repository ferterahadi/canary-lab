import type { AgentModelsConfig } from './agent-models'

// `external` was retired in 2.2.0: whether a run parks for an external client
// is decided by the request's MCP origin, not by workspace config, so the
// config row only ever chose that GUI-started runs should wait. Stored
// `external` values migrate to `claude` silently on load.
export type HealAgentChoice = 'auto' | 'claude' | 'codex' | 'manual'
export type EditorChoice = 'auto' | 'vscode' | 'cursor' | 'system'

export interface ProjectConfig {
  healAgent: HealAgentChoice
  editor: EditorChoice
  /** Per-agent, per-stage model + reasoning-effort defaults for every internal
   *  agent spawn. Absent stages run on the agent's own default. External-agent
   *  work is out of scope by design: no server-side process exists there. */
  agentModels: AgentModelsConfig
  /** Ask which models to use at every launch (flight / suite run / coverage)
   *  instead of applying `agentModels` silently. */
  askModelsOnLaunch: boolean
  personalWikiPath: string | null
  /** Open a draft pull request automatically when a run heals green. On by
   *  default: an unattended repair should leave something to review. Turn it
   *  off for a workspace whose repos shouldn't receive machine-pushed
   *  branches. */
  autoProposePr: boolean
  /** Offer the shipped demos from the status bar. On by default so a new
   *  workspace can find them; turned off from the demo chooser itself once
   *  somebody has seen what they wanted. Workspace-level rather than
   *  per-browser: "I'm done with the demos" is a fact about this project, not
   *  about the machine that happened to dismiss them. */
  showDemo: boolean
  /** Localhost port for the UI + MCP HTTP server. Absent → DEFAULT_PORT. */
  port?: number
}

// Older servers omit these fields; browser readers retain their existing defaults.
type LegacyOptionalFields = 'agentModels' | 'askModelsOnLaunch' | 'autoProposePr' | 'showDemo'
export type ProjectConfigResponse = Omit<ProjectConfig, LegacyOptionalFields>
  & Partial<Pick<ProjectConfig, LegacyOptionalFields>>
