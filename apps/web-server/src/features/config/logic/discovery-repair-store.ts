import path from 'path'
import fs from 'fs'
import { FileBackedTaskStore } from '../../../../../../shared/lib/file-backed-task-store'
import { discoveryRepairActive, type DiscoveryRepair } from '../../../../../../shared/discovery-repair'

const stores = new Map<string, FileBackedTaskStore<DiscoveryRepair>>()

export function discoveryRepairStore(logsDir: string): FileBackedTaskStore<DiscoveryRepair> {
  const key = path.resolve(logsDir)
  const existing = stores.get(key)
  if (existing) return existing
  const store = new FileBackedTaskStore<DiscoveryRepair>({
    logsDir, dirName: 'discovery-repairs', recordFile: 'repair.json',
    idOf: (r) => r.id,
    indexEntryOf: (r) => ({ id: r.id, createdAt: r.createdAt, feature: r.feature, status: r.status }),
    featureOf: (r) => r.feature, withFeature: (r, feature) => ({ ...r, feature }),
    sortNewestFirst: true,
    reconcile: {
      // An external editor survives a server restart. Keep its ownership; a
      // lost heartbeat is not evidence that it has stopped touching files.
      isInterrupted: (r) => discoveryRepairActive(r) && (r.owner.kind === 'internal' || r.status === 'verifying' || !fs.existsSync(r.promptPath)),
      mark: (r, now) => ({ ...r, status: 'failed', endedAt: now, updatedAt: now, message: 'Repair interrupted by server restart', diagnostic: 'Repair interrupted by server restart. Resume repair to verify the current files.' }),
    },
  })
  stores.set(key, store)
  return store
}
