import { COVERAGE_FRESHNESS_LEASE_MS, COVERAGE_RECONCILE_MS } from '@shared/coverage/freshness'
import * as api from '../api/client'
import { useLiveResource } from './use-live-resource'

/** All live coverage readers share the same event, fallback, and read lease. */
export function useLiveCoverage(feature: string | null, refreshKey?: string) {
  return useLiveResource('coverage', feature, api.getFeatureCoverage, {
    reconcileMs: COVERAGE_RECONCILE_MS, leaseMs: COVERAGE_FRESHNESS_LEASE_MS, refreshKey,
  })
}

/** One workspace-wide freshness read for list surfaces, with the same live
 * event and reconciliation path as the selected feature ledger. */
export function useLiveCoverageStates(features: string[] | null) {
  // Row ordering differs across list surfaces; the sorted set lets their
  // simultaneous reads share one request without hiding feature additions.
  const key = features?.length ? [...features].sort().join(',') : null
  return useLiveResource('coverage', key, (_key, opts) => api.listCoverageStates(opts), {
    reconcileMs: COVERAGE_RECONCILE_MS, leaseMs: COVERAGE_FRESHNESS_LEASE_MS,
  })
}
