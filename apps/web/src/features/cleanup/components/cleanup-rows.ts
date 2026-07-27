import type { CleanupListing, CleanupWorktree, ExecutionType, PortifyCleanupEntry, RunStatus } from '@/shared/api/types'

// A unified table row covering both indexed runs and orphan directories.
export interface Row {
  runId: string
  feature: string
  kind: ExecutionType | 'orphan'
  status: RunStatus | null
  startedAt: string | null
  folderBytes: number
  artifactBytes: number
  active: boolean
  isOrphan: boolean
}

export const KIND_LABEL: Record<Row['kind'], string> = {
  run: 'TEST',
  verify: 'VERIFY',
  boot: 'BOOT',
  benchmark: 'BENCH',
  orphan: 'ORPHAN',
}

export const STATUS_COLOR: Record<RunStatus, string> = {
  running: 'var(--running)',
  healing: 'var(--warning)',
  queued: 'var(--text-secondary)',
  passed: 'var(--success)',
  failed: 'var(--danger)',
  aborted: 'var(--text-muted)',
}

export const WORKTREE_OWNER_LABEL: Record<CleanupWorktree['ownerKind'], string> = {
  run: 'RUN',
  benchmark: 'BENCH',
  portify: 'PORTIFY',
  unknown: 'ORPHAN',
}

// Portify workflow statuses, coloured like the rest of the cleanup UI: greens
// for the resolved overlay, rose for failures, muted for cancelled / in-flight.
export const PORTIFY_STATUS_COLOR: Record<PortifyCleanupEntry['status'], string> = {
  planning: 'var(--running)',
  editing: 'var(--running)',
  verifying: 'var(--running)',
  'ready-to-save': 'var(--success)',
  saved: 'var(--success)',
  failed: 'var(--danger)',
  aborted: 'var(--text-muted)',
}

export const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000

export const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000

export const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000

export const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000

export const HUNDRED_MB = 100 * 1024 * 1024

export type SortKey = 'runId' | 'kind' | 'status' | 'feature' | 'age' | 'folder' | 'artifacts'

// Numeric columns default to descending (biggest/newest first); text columns to ascending.
export const NUMERIC_KEYS: ReadonlySet<SortKey> = new Set(['age', 'folder', 'artifacts'])

export function sortValue(r: Row, key: SortKey): string | number {
  switch (key) {
    case 'runId': return r.runId
    case 'kind': return KIND_LABEL[r.kind]
    case 'status': return r.status ?? ''
    case 'feature': return r.feature
    case 'age': return r.startedAt ? Date.parse(r.startedAt) : 0
    case 'folder': return r.folderBytes
    case 'artifacts': return r.artifactBytes
  }
}

export function listingToRows(listing: CleanupListing): Row[] {
  const runs: Row[] = listing.runs.map((r) => ({
    runId: r.runId,
    feature: r.feature,
    kind: r.executionType,
    status: r.status,
    startedAt: r.startedAt,
    folderBytes: r.folderBytes,
    artifactBytes: r.artifactBytes,
    active: r.active,
    isOrphan: false,
  }))
  const orphans: Row[] = listing.orphans.map((o) => ({
    runId: o.runId,
    feature: '—',
    kind: 'orphan' as const,
    status: null,
    startedAt: null,
    folderBytes: o.folderBytes,
    artifactBytes: 0,
    active: false,
    isOrphan: true,
  }))
  return [...runs, ...orphans].sort((a, b) => b.folderBytes - a.folderBytes)
}

// The launcher pill already says "Cleanup", so the tabs name the thing being
// cleaned — "Runs", not "Log Cleanup" (which made the siblings read as
// something other than log cleanup).
export const CLEANUP_TABS = [
  { key: 'runs', label: 'Runs' },
  { key: 'worktrees', label: 'Worktrees' },
  { key: 'portify', label: 'Portify' },
] as const

export type CleanupTab = (typeof CLEANUP_TABS)[number]['key']
