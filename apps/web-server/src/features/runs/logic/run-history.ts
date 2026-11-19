import type { RunStore } from './run-store'
import type { RunHistoryEntry } from '../../../../../../shared/run-collaboration'
import { buildRunPaths, runDirFor } from './runtime/run-paths'
import { readJournal } from './journal-store'

/** Links aggregate evidence; they never rewrite a predecessor or its journal. */
export function readRunHistory(store: RunStore, runId: string): RunHistoryEntry[] {
  const selected = store.get(runId)
  if (!selected) return []
  const candidates = store.list({ feature: selected.manifest.feature }).flatMap((row) => {
    const detail = store.get(row.runId)
    return detail && detail.manifest.env === selected.manifest.env ? [detail] : []
  })
  const ids = new Set([runId])
  let previous = 0
  while (previous !== ids.size) {
    previous = ids.size
    for (const d of candidates) {
      const parent = d.manifest.continuationOf
      if (parent && (ids.has(d.runId) || ids.has(parent))) { ids.add(parent); ids.add(d.runId) }
    }
  }
  return candidates.filter((d) => ids.has(d.runId)).sort((a, b) => a.manifest.startedAt.localeCompare(b.manifest.startedAt))
    .map((d) => ({ runId: d.runId, feature: d.manifest.feature, status: d.manifest.status,
      startedAt: d.manifest.startedAt, continuationOf: d.manifest.continuationOf, executions: d.executions ?? [],
      journal: readJournal(buildRunPaths(runDirFor(store.logsDir, d.runId)).diagnosisJournalPath).sections }))
}
