// Canonical run-mode types shared by both apps (web-server + web client).
//
// Every Canary Lab feature with a "run" can execute in one of two producer
// modes: `internal` (the web-server spawns its own agent and drives the work)
// or `external` (the user's own Claude/Codex client drives it via MCP, and the
// web-server is broker + store). These types unify the discriminator, the
// client identity union, and the external-session metadata block that used to
// be re-declared per feature.

/** The external AI client driving (or claiming) an external-producer run. */
export type ClientKind =
  | 'claude-cli'
  | 'claude-desktop'
  | 'codex-cli'
  | 'codex-desktop'
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
    value === 'claude-cli' ||
    value === 'claude-desktop' ||
    value === 'codex-cli' ||
    value === 'codex-desktop' ||
    value === 'other'
  )
}
