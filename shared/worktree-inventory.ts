export type WorktreeOwnerKind = 'run' | 'benchmark' | 'portify' | 'unknown'

export interface WorktreeEntry {
  /** Worktree root (absolute). */
  path: string
  /** The owning repo's git toplevel (where `git worktree remove` is run). */
  sourceRoot: string
  /** Short ref the worktree is checked out at (branch short-name or HEAD sha). */
  ref: string
  ownerKind: WorktreeOwnerKind
  /** Run/benchmark id parsed from the logs-relative path, or null. */
  ownerId: string | null
  /** Slot for benchmark worktrees: 'arm-A' | 'arm-B' | 'staging' | 'inspect'. */
  slot: string | null
  /** Disk size of the worktree dir (0 when the dir is gone). */
  bytes: number
  /** ms since the worktree root's mtime, or null when the dir is gone. */
  ageMs: number | null
  /** False when git still registers the worktree but the dir is missing (prunable). */
  exists: boolean
}
