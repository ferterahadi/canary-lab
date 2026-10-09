import type { WorktreeEntry } from './worktree-inventory'
// The cleanup dialog's listings of runs and portify workflows, as the cleanup
// routes return them.
import type { PortifyStatus } from './portify-index'
import type { RunManifest } from './run-manifest'
import type { ExecutionType } from './verification'

/** One indexed run, annotated with disk usage for the cleanup view. */
export interface CleanupRunEntry {
  runId: string
  feature: string
  executionType: ExecutionType
  status: RunManifest['status']
  startedAt: string
  endedAt?: string
  /** Total bytes of the whole run directory. */
  folderBytes: number
  /** Bytes held by the trimmable Playwright artifact dirs (subset of folder). */
  artifactBytes: number
  /** True when the run is still live (registered orchestrator or active status).
   *  Active runs cannot be trimmed or deleted. */
  active: boolean
}

/** A directory under `logs/runs/` with no entry in `index.json` — an
 *  interrupted/never-finalized run. Delete-only; it has no manifest. */
export interface CleanupOrphan {
  runId: string
  folderBytes: number
}

export interface CleanupListing {
  runs: CleanupRunEntry[]
  orphans: CleanupOrphan[]
  totals: {
    /** Every run folder + every orphan folder. */
    totalBytes: number
    /** Artifact bytes reclaimable by trimming non-active runs. */
    reclaimableTrimBytes: number
    /** Folder bytes reclaimable by deleting non-active runs + all orphans. */
    reclaimableDeleteBytes: number
  }
}

// Disk-usage view for the Log Cleanup "Portify" tab: every port-ification
// workflow record under `<logs>/portify/<id>/` with its folder size, so the UI
// can prune stale records (the × that used to live in the Ports-tab history).
// Mirrors the runs `cleanupListing` shape, scoped to portify. Worktrees the
// workflows spawned are reclaimed separately via the worktree inventory (they
// classify as ownerKind 'portify').

export interface PortifyCleanupEntry {
  workflowId: string
  feature: string
  status: PortifyStatus
  startedAt: string
  endedAt?: string
  /** Disk size of `<logs>/portify/<id>/` (record + agent.log + verify/ + snapshot). */
  folderBytes: number
}

export interface PortifyCleanupListing {
  workflows: PortifyCleanupEntry[]
  totalBytes: number
}

export interface CleanupWorktree extends WorktreeEntry {
  /** Owner run/benchmark is still running — removal is refused. */
  active: boolean
}
