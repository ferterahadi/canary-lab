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
  /** HEAD of the user's branch after merging via the UI/MCP merge action. */
  mergeCommitSha?: string
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
   *  `attempt` (the auto-retry budget) — feedback rounds are unbounded. Optional:
   *  manifests persisted before this field existed deserialize without it. */
  feedbackRounds?: number
  startedAt: string
  endedAt?: string
  /** Unified diff of the agent's edits (config + source), for the review screen. */
  diff?: string
  verification?: PortifyVerification
  error?: string
  /** When the branch was merged into the user's branch via the merge action.
   *  Manual `git merge`s don't set this — merged-ness is COMPUTED live from git
   *  (merge-base --is-ancestor); this only records the in-app action. Optional:
   *  manifests persisted before this field existed deserialize without it. */
  mergedAt?: string
}

export interface PortifyIndexEntry {
  workflowId: string
  feature: string
  status: PortifyStatus
  /** Branch the rewrite lands on — surfaced in the history list so a committed
   *  workflow's branch is findable without reopening it. Optional: index
   *  entries persisted before this field existed deserialize without it. */
  branch?: string
  startedAt: string
  endedAt?: string
  /** Set when the branch was merged via the in-app merge action. */
  mergedAt?: string
}

/** Live merge readiness of one git root holding portify commits. */
export interface PortifyRepoMergeStatus {
  /** Member repo names sharing this git root (comma-joined for display). */
  name: string
  gitRoot: string
  commitSha: string
  branchExists: boolean
  currentBranch: string | null
  dirty: boolean
  mergeInProgress: boolean
  merged: boolean
}

export interface PortifyMergeStatusResult {
  workflowId: string
  branch: string
  repos: PortifyRepoMergeStatus[]
  /** Every repo with portify commits has them in its HEAD's ancestry. */
  merged: boolean
  /** Committed without source changes — there is no branch to merge. */
  nothingToMerge: boolean
}

export interface PortifyRepoMergeResult {
  name: string
  ok: boolean
  mergeCommitSha?: string
  alreadyMerged?: boolean
  conflictFiles?: string[]
  error?: string
}

export interface PortifyMergeResult {
  ok: boolean
  results: PortifyRepoMergeResult[]
  manifest: PortifyManifest
}

export interface StartPortifyInput {
  feature: string
  agent?: HealAgent
  maxAttempts?: number
}

export interface StartPortifyResult {
  workflowId: string
}
