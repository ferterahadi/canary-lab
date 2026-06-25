// Canonical run-mode types shared by both apps (web-server + web client).
//
// Every Canary Lab feature with a "run" can execute in one of two producer
// modes: `internal` (the web-server spawns its own agent and drives the work)
// or `external` (the user's own Claude/Codex client drives it via MCP, and the
// web-server is broker + store). These types unify the discriminator, the
// client identity union, and the external-session metadata block that used to
// be re-declared per feature.

/** The external AI client driving (or claiming) an external-producer run.
 *  `claude`/`codex` are human-driven interactive clients (Desktop or CLI — we
 *  no longer distinguish; both may heal). `claude-pty`/`codex-pty` are agents
 *  the runner itself spawns (benchmark sabotage, portify, …); they connect to
 *  the same MCP but must NEVER claim heal, or they'd claim their own run. The
 *  runner tags them deterministically via `CANARY_LAB_MCP_CLIENT_KIND` (see
 *  `runAgentProcess`), so detection never has to guess the dangerous case. */
export type ClientKind =
  | 'claude'
  | 'codex'
  | 'claude-pty'
  | 'codex-pty'
  | 'other'

/** Who drives a feature run. `internal` = app-spawned agent; `external` = the
 *  user's own client via MCP. (Portify historically called `internal` "local".) */
export type RunProducer = 'internal' | 'external'

/** Identity of the external client that owns an external-producer run. The
 *  agent transcript lives in the user's client, so the server only tracks this
 *  for status display + ownership checks. Heal extends this with liveness
 *  fields (claimedAt/lastHeartbeatAt/status/cycleCount). */
export interface ExternalSessionMeta {
  clientKind: ClientKind
  sessionId: string
  conversationName?: string
  sessionUrl?: string
}

/** Type guard for `ClientKind`, for validating untrusted input (MCP args,
 *  persisted records). */
export function isClientKind(value: unknown): value is ClientKind {
  return (
    value === 'claude' ||
    value === 'codex' ||
    value === 'claude-pty' ||
    value === 'codex-pty' ||
    value === 'other'
  )
}
