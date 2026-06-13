import type { HealAgent } from '../auto-heal'

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

export interface PortifyManifest {
  workflowId: string
  feature: string
  featureDir: string
  /** Every product repo the workflow edits — one isolated scratch worktree each. */
  repos: PortifyRepoState[]
  env?: string
  agent: HealAgent
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
