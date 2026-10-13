import type { KnownModelOption, ModelAgentKind } from './agent-models'

export type AgentProbeState = 'ok' | 'auth' | 'missing'

export interface AgentProbe {
  agent: ModelAgentKind
  state: AgentProbeState
  binaryPath: string | null
  version: string | null
  /** Models this installed CLI currently exposes to users. Empty when the CLI
   *  has no discovery command or discovery fails; configuring remains usable
   *  through Agent default and Custom id. */
  models: readonly KnownModelOption[]
  /** One-line fix for the warning strip; null when state is `ok`. */
  remedy: string | null
}

export interface AgentProbeSnapshot {
  probedAt: string
  claude: AgentProbe
  codex: AgentProbe
}

// Runtime model discovery was absent from older server responses.
export type AgentProbeResponse = Omit<AgentProbe, 'models'> & Partial<Pick<AgentProbe, 'models'>>
export type AgentProbeSnapshotResponse = Omit<AgentProbeSnapshot, 'claude' | 'codex'> & {
  claude: AgentProbeResponse
  codex: AgentProbeResponse
}
