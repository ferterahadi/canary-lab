import { dirSizeBytes } from '../../../runs/logic/run-store'
import { portifyDir } from './paths'
import type { PortifyStore } from './store'
import type { PortifyStatus } from './types'

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

export function portifyCleanupListing(
  store: Pick<PortifyStore, 'list'>,
  logsDir: string,
  sizeOf: (dir: string) => number = dirSizeBytes,
): PortifyCleanupListing {
  const workflows: PortifyCleanupEntry[] = store.list().map((e) => ({
    workflowId: e.workflowId,
    feature: e.feature,
    status: e.status,
    startedAt: e.startedAt,
    ...(e.endedAt ? { endedAt: e.endedAt } : {}),
    folderBytes: sizeOf(portifyDir(logsDir, e.workflowId)),
  }))
  // Biggest-first, matching the runs/worktrees tables' default sort.
  workflows.sort((a, b) => b.folderBytes - a.folderBytes)
  const totalBytes = workflows.reduce((s, w) => s + w.folderBytes, 0)
  return { workflows, totalBytes }
}
