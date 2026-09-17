import { COVERAGE_FRESHNESS_LEASE_MS, COVERAGE_RECONCILE_MS } from '@shared/coverage/freshness'
import * as api from '../api/client'
import { useLiveResource } from './use-live-resource'

/** All live coverage readers share the same event, fallback, and read lease. */
export function useLiveCoverage(feature: string | null, refreshKey?: string) {
  return useLiveResource('coverage', feature, api.getFeatureCoverage, {
    reconcileMs: COVERAGE_RECONCILE_MS, leaseMs: COVERAGE_FRESHNESS_LEASE_MS, refreshKey,
  })
}
