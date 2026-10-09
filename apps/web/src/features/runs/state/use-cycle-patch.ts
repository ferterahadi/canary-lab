import { getRunCyclePatch, type RunCyclePatch } from '@/shared/api/runs'
import { ApiError } from '@/shared/api/internal'
import { useLiveResource, type LiveResource } from '@/shared/state/use-live-resource'

/** A repair cycle's own diff, by the journal iteration that recorded it. The
 *  patch is written with its journal entry, so it rides the journal's live
 *  topic: a new or rewritten entry re-reads it. `'missing'` means the run
 *  never persisted one — the entry's inline block is then the only copy. */
export function useCyclePatch(runId: string, iteration: number | null): LiveResource<RunCyclePatch | 'missing'> {
  return useLiveResource('journal', iteration === null ? null : JSON.stringify([runId, iteration]),
    async (key) => {
      try {
        return await getRunCyclePatch(runId, (JSON.parse(key) as [string, number])[1])
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) return 'missing'
        throw err
      }
    }, { scope: runId, cache: 'run-cycle-patch' })
}
