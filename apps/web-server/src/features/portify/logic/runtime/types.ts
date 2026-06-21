import type { HealAgent } from '../../../runs/logic/runtime/auto-heal'

// Port-ification workflow: rewrite a feature's apps so their listen ports are
// injectable (read from an env var, declared as `ports` slots in the config),
// PROVEN by booting the stack twice concurrently on different ports. The flow
// edits the product repo on a dedicated branch in a git worktree, verifies, and
// ends at a user-confirmed commit. Modeled on the benchmark subsystem.

// Ephemeral-overlay model: the workflow parks at `ready-to-save` and ends at
// `saved` (the captured patch is written to features/<feature>/portify/, never
// committed/merged).
export type PortifyStatus =
  | 'planning'
  | 'editing'
  | 'verifying'
  | 'ready-to-save'
  | 'saved'
  | 'failed'
  | 'aborted'

export interface PortifyBootInstance {
  /** Slot name → port this boot was assigned. */
  ports: Record<string, number>
  ok: boolean
  /** When !ok, which service failed and why. */
  failedService?: string
  detail?: string
}

export interface PortifyVerification {
  ok: boolean
  instances: PortifyBootInstance[]
  /** Aggregated failure context fed back to the agent on retry. */
  failureDetail?: string
  /** True when the boot failed only because a downstream dependency was
   *  unreachable (e.g. the DB is down) — an ENVIRONMENT problem the port
   *  rewrite cannot fix. Signals the orchestrator to stop retrying. */
  notPortFixable?: boolean
}

export interface PortifyRepoState {
  name: string
  /** Canonical localPath of the product repo. */
  path: string
  /** Toplevel of this repo's isolated scratch worktree (set once setup runs). */
  worktreePath?: string
  /** HEAD the scratch worktree was cut from. */
  baseSha?: string
}

/** Who drives the port-ification edits.
 *  - `local`: an agent spawned IN the app process edits the scratch worktree.
 *  - `external`: the agent runs in the user's OWN Claude/Codex client (via MCP)
 *    and edits the scratch worktree IN PLACE; the app process only sets up the
 *    worktree, verifies (double-boot), and saves the overlay. Mirrors external
 *    heal/wizard/eval — the transcript lives in the user's client, not here. */
export type PortifyProducer = 'local' | 'external'

export type PortifyClientKind = 'claude-cli' | 'claude-desktop' | 'codex-cli' | 'codex-desktop' | 'other'

/** The external client that owns an external-producer workflow. Surfaced
 *  status-only in the UI (the agent's transcript lives in the user's client). */
export interface PortifyExternalSession {
  clientKind: PortifyClientKind
  sessionId: string
  conversationName?: string
  sessionUrl?: string
}

export interface PortifyManifest {
  workflowId: string
  feature: string
  featureDir: string
  /** Every product repo the workflow edits — one isolated scratch worktree each. */
  repos: PortifyRepoState[]
  env?: string
  agent: HealAgent
  /** Defaults to `local` (legacy manifests have no field). `external` means the
   *  agent runs in the user's own client and edits the worktree in place. */
  producer?: PortifyProducer
  /** Set only for `producer: 'external'` — the claiming client's identity. */
  external?: PortifyExternalSession
  /** Ephemeral scratch-branch name created in the scratch worktree(s) and
   *  discarded on save/cancel — it never lands in the product repo. */
  branch: string
  status: PortifyStatus
  attempt: number
  maxAttempts: number
  /** User-driven revise passes after the first `ready-to-save`. Separate from
   *  `attempt` (the auto-retry budget) — feedback rounds are unbounded. Optional:
   *  manifests persisted before this field existed deserialize without it. */
  feedbackRounds?: number
  startedAt: string
  endedAt?: string
  /** Unified diff of the agent's edits (config + source), for the review screen.
   *  On `save` this diff is captured as the feature's ephemeral overlay. */
  diff?: string
  verification?: PortifyVerification
  error?: string
}

export interface PortifyIndexEntry {
  workflowId: string
  feature: string
  status: PortifyStatus
  /** Ephemeral scratch-branch name — surfaced in the history list. Optional:
   *  index entries persisted before this field existed deserialize without it. */
  branch?: string
  startedAt: string
  endedAt?: string
}

export interface StartPortifyInput {
  feature: string
  agent?: HealAgent
  maxAttempts?: number
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
  /** The scratch worktree path to edit each repo's source in. */
  targets: ExternalPortifyEditTarget[]
  /** Absolute path of the feature config to edit in place (declare `ports` slots). */
  configPath: string
  /** The port-ification task instructions for the external client (same prompt
   *  the local agent would receive). */
  instructions: string
}
