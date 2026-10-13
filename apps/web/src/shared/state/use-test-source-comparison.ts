import * as featuresApi from '../api/features'
import { ApiError } from '../api/internal'
import type { TestSourceComparison } from '@shared/test-review'
import { useLiveResource } from './use-live-resource'

type ComparisonResult = { kind: 'comparison'; comparison: TestSourceComparison }
  | { kind: 'missing-suite' | 'missing-snapshot' }
type Comparison = TestSourceComparison | { state: 'loading' | 'error'; files: string[]; differences: [] }

/** Both comparison surfaces recover missed file events, including removal and
 * restoration. A failed read retains evidence but cannot certify an action.
 * `snapshotDir` is null when the run has no snapshot and undefined while its
 * manifest is still unknown; the server reports a missing snapshot itself. */
export function useTestSourceComparison({ feature, runId, featureDir, snapshotDir, refreshKey }: {
  feature: string | null | undefined
  runId: string | null | undefined
  featureDir: string | undefined
  snapshotDir: string | null | undefined
  refreshKey: string | number
}) {
  const key = feature && runId && snapshotDir !== null ? JSON.stringify([feature, runId]) : null
  // The run's directories reread rather than rekey, so a manifest that arrives
  // after the comparison keeps it on screen while the reread confirms it.
  const resource = useLiveResource<ComparisonResult>('tests', key, async () => {
    try {
      return { kind: 'comparison', comparison: await featuresApi.getTestSourceComparison(feature!, runId!) }
    } catch (error) {
      if (error instanceof ApiError && error.status === 404 && error.message === 'Suite not found') return { kind: 'missing-suite' }
      if (error instanceof ApiError && error.status === 409 && /snapshot/i.test(error.message)) return { kind: 'missing-snapshot' }
      throw error
    }
  }, { reconcileMs: 10_000, leaseMs: 15_000, refreshKey: JSON.stringify([refreshKey, featureDir, snapshotDir]) })
  const missingSuite = resource.value?.kind === 'missing-suite'
  const missingSnapshot = snapshotDir === null || resource.value?.kind === 'missing-snapshot'
  const comparison: Comparison = missingSuite || missingSnapshot
    ? { state: 'unavailable', files: [], differences: [], reasons: [missingSuite ? 'Suite not found' : 'Snapshot unavailable'] }
    : resource.value?.kind === 'comparison' ? resource.value.comparison
      : { state: resource.error ? 'error' : 'loading', files: [], differences: [] }
  const error = resource.error ? 'Could not list all comparison files. Showing the available files.'
    : comparison.state === 'unavailable' ? 'Test change counts are unavailable because source or snapshot information is incomplete.' : null
  return { comparison, missingSuite, missingSnapshot, error, confirmed: resource.confirmed && comparison.state === 'ready' }
}
