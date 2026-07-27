// Type definitions for the canary-lab web UI. Mirrors the server-side return
// shapes in apps/web-server/lib/{run-store,feature-loader,journal-store}.ts.
// Run-state primitives are shared with the server so recovery behavior has one
// semantic model; feature/journal/wizard shapes remain web-local API mirrors.
import type { RunStatus } from '@shared/run-state'
import type { ExecutionType } from '@shared/verification'

// ─── Log cleanup ─────────────────────────────────────────────────────────

export interface CleanupRunEntry {
  runId: string
  feature: string
  executionType: ExecutionType
  status: RunStatus
  startedAt: string
  endedAt?: string
  folderBytes: number
  artifactBytes: number
  active: boolean
}

export interface CleanupOrphan {
  runId: string
  folderBytes: number
}

export interface CleanupListing {
  runs: CleanupRunEntry[]
  orphans: CleanupOrphan[]
  totals: {
    totalBytes: number
    reclaimableTrimBytes: number
    reclaimableDeleteBytes: number
  }
}

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

// A port-ification workflow record on disk, for the Log Cleanup "Portify" tab.
// Mirrors the server PortifyCleanupEntry; status reuses the portify lifecycle.
export interface PortifyCleanupEntry {
  workflowId: string
  feature: string
  status: 'planning' | 'editing' | 'verifying' | 'ready-to-save' | 'saved' | 'failed' | 'aborted'
  startedAt: string
  endedAt?: string
  folderBytes: number
}

export interface PortifyCleanupListing {
  workflows: PortifyCleanupEntry[]
  totalBytes: number
}
