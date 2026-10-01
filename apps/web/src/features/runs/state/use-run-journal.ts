import { listJournal } from '@/shared/api/client'
import { useLiveResource } from '@/shared/state/use-live-resource'
import { classifyOutcome, newestFirst } from '../utils/journal-utils'

export function useRunJournal(feature: string, runId: string, refreshKey = 0) {
  return useLiveResource('journal', JSON.stringify([feature, runId]),
    async () => newestFirst(await listJournal({ feature, run: runId })), {
      scope: runId,
      cache: 'run-journal',
      refreshKey,
      pollIntervalMs: 2000,
      pollWhile: (entries) => entries === null || entries.some((entry) => classifyOutcome(entry.outcome) === 'pending'),
    })
}
