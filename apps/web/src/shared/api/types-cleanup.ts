// A git worktree canary-lab created under the logs dir (mirrors the server
// WorktreeEntry, plus `active`). Surfaced in the Log Cleanup worktree list.
export interface CleanupWorktree {
  path: string
  sourceRoot: string
  ref: string
  ownerKind: 'run' | 'benchmark' | 'portify' | 'unknown'
  ownerId: string | null
  slot: string | null
  bytes: number
  ageMs: number | null
  exists: boolean
  /** Owner run/benchmark is still running — removal is refused. */
  active: boolean
}

