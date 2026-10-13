import type { HealAgent } from '../../../agent-sessions/logic/agent-binary'
import type { ClientKind, ExternalSessionMeta, RunProducer } from '../../../../../../../shared/run-mode'

// Port-ification workflow: rewrite a feature's apps so their listen ports are
// injectable (read from an env var, declared as `ports` slots in the config),
// PROVEN by booting the stack twice concurrently on different ports. The flow
// edits the product repo on a dedicated branch in a git worktree, verifies, and
// ends at a user-confirmed commit. Modeled on the benchmark subsystem.

/** Who drives the port-ification edits.
 *  - `internal`: an agent spawned IN the app process edits the scratch worktree.
 *  - `external`: the agent runs in the user's OWN Claude/Codex client (via MCP)
 *    and edits the scratch worktree IN PLACE; the app process only sets up the
 *    worktree, verifies (double-boot), and saves the overlay. Mirrors external
 *    heal/wizard/eval — the transcript lives in the user's client, not here. */
export type PortifyProducer = RunProducer

export type PortifyClientKind = ClientKind

/** The external client that owns an external-producer workflow. Surfaced
 *  status-only in the UI (the agent's transcript lives in the user's client). */
export type PortifyExternalSession = ExternalSessionMeta

export interface StartPortifyInput {
  feature: string
  agent?: HealAgent
  maxAttempts?: number
  /** Launch-gate model+effort override for the spawned agent — a raw
   *  `{ model?, effort? }` from the request body, normalized by the runner's
   *  `resolveModels` before it can win over workspace config. */
  models?: unknown
}

export interface StartPortifyResult {
  workflowId: string
}

export interface StartExternalPortifyInput {
  feature: string
  clientKind: PortifyClientKind
  sessionId: string
  conversationName?: string
  sessionUrl?: string
}

/** Where the external client edits a repo's source — its path inside the scratch
 *  worktree the app process created. */
export interface ExternalPortifyEditTarget {
  name: string
  editPath: string
}

export interface StartExternalPortifyResult {
  workflowId: string
  /** Verification can start immediately when injection is already declared.
   * Absent on older providers, which always handed back the editing window. */
  status?: 'editing' | 'verifying'
  /** The scratch worktree path to edit each repo's source in. */
  targets: ExternalPortifyEditTarget[]
  /** Absolute path of the feature config to edit in place (declare `ports` slots). */
  configPath: string
  /** The port-ification task instructions for the external client (same prompt
   *  the local agent would receive). */
  instructions: string
}
