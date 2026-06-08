import type { HealAgent } from '../auto-heal'

// Port-ification workflow: rewrite a feature's apps so their listen ports are
// injectable (read from an env var, declared as `ports` slots in the config),
// PROVEN by booting the stack twice concurrently on different ports. The flow
// edits the product repo on a dedicated branch in a git worktree, verifies, and
// ends at a user-confirmed commit. Modeled on the benchmark subsystem.

export type PortifyStatus =
  | 'planning'
  | 'editing'
  | 'verifying'
  | 'ready-to-commit'
  | 'committed'
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
  /** Toplevel of this repo's isolated worktree (set once setup runs). */
  worktreePath?: string
  /** HEAD the branch was cut from. */
  baseSha?: string
  /** Commit SHA on the branch once the user commits. */
  commitSha?: string
}

export interface PortifyManifest {
  workflowId: string
  feature: string
  featureDir: string
  /** Every product repo the workflow edits — one isolated worktree each. */
  repos: PortifyRepoState[]
  env?: string
  agent: HealAgent
  /** Shared branch name created in every repo. */
  branch: string
  status: PortifyStatus
  attempt: number
  maxAttempts: number
  /** User-driven revise passes after the first `ready-to-commit`. Separate from
   *  `attempt` (the auto-retry budget) — feedback rounds are unbounded. */
  feedbackRounds: number
  startedAt: string
  endedAt?: string
  /** Unified diff of the agent's edits (config + source), for the review screen. */
  diff?: string
  verification?: PortifyVerification
  error?: string
}

export interface PortifyIndexEntry {
  workflowId: string
  feature: string
  status: PortifyStatus
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
