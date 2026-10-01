import { dirSizeBytes } from '../../../runs/logic/run-artifacts'
import { portifyDir } from './paths'
import type { PortifyStore } from './store'
import type { PortifyCleanupEntry, PortifyCleanupListing } from '../../../../../../../shared/cleanup-listing'

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
