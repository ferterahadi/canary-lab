import type { RunDetail } from '../../../../../../shared/run-detail'
import type { RunIndexEntry } from '../../../../../../shared/run-index'
import type { RunStore } from './run-store'
import { compareActiveRuns } from './active-run-order'

/** Eligibility belongs to the caller: continuation and restart admit different runs.
 *  An eligible row whose server is gone is settled rather than selected, so a
 *  caller never continues a run that nothing drives. */
export function selectRunForFeature(
  store: Pick<RunStore, 'list' | 'get' | 'settleIfOrphaned'>,
  feature: string,
  env: string | undefined,
  eligibleEntry: (entry: RunIndexEntry) => boolean,
  eligibleDetail: (detail: RunDetail) => boolean,
): RunDetail | null {
  const candidates: Array<{ detail: RunDetail; startedAt: string }> = []
  for (const entry of store.list({ feature })) {
    if (!eligibleEntry(entry) || store.settleIfOrphaned(entry.runId)) continue
    const detail = store.get(entry.runId)
    if (!detail || !eligibleDetail(detail)) continue
    if (env && detail.manifest.env !== env) continue
    candidates.push({ detail, startedAt: entry.startedAt })
  }
  candidates.sort(compareActiveRuns)
  return candidates[0]?.detail ?? null
}
