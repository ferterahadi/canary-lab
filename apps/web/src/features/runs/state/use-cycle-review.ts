import type { RunCycleReview } from '@shared/test-view/cycle-review'
import { getRunCycleReview } from '@/shared/api/runs'
import { ApiError } from '@/shared/api/internal'
import { useLiveResource, type LiveResource } from '@/shared/state/use-live-resource'

/** A repair cycle's files and rows, by the journal iteration that recorded
 *  them. The patch is written just before its journal entry, so it rides the
 *  journal's live topic: a new or rewritten entry re-reads it. `'missing'`
 *  means the run never persisted one — the entry's inline block is then the
 *  only copy. */
export function useCycleReview(runId: string, iteration: number | null): LiveResource<RunCycleReview | 'missing'> {
  return useLiveResource('journal', iteration === null ? null : JSON.stringify([runId, iteration]),
    async (key) => {
      try {
        return await getRunCycleReview(runId, (JSON.parse(key) as [string, number])[1])
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) return 'missing'
        throw err
      }
    }, { scope: runId, cache: 'run-cycle-review' })
}
