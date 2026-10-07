import type { RunDetail } from '../../../../../../shared/run-detail'
import type { RunIndexEntry } from '../../../../../../shared/run-index'
import type { RunStore } from './run-store'
import { compareActiveRuns } from './active-run-order'

/** Eligibility belongs to the caller: continuation and restart admit different runs. */
export function selectRunForFeature(
  store: Pick<RunStore, 'list' | 'get'>,
  feature: string,
  env: string | undefined,
  eligibleEntry: (entry: RunIndexEntry) => boolean,
  eligibleDetail: (detail: RunDetail) => boolean,
): RunDetail | null {
  const candidates: Array<{ detail: RunDetail; startedAt: string }> = []
  for (const entry of store.list({ feature })) {
    if (!eligibleEntry(entry)) continue
    const detail = store.get(entry.runId)
    if (!detail || !eligibleDetail(detail)) continue
    if (env && detail.manifest.env !== env) continue
    candidates.push({ detail, startedAt: entry.startedAt })
  }
  candidates.sort(compareActiveRuns)
  return candidates[0]?.detail ?? null
}
