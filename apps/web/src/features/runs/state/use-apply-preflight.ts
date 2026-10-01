import { REPOSITORY_FRESHNESS_MS, REPOSITORY_RECONCILE_MS, repositoryConsumerKey } from '@shared/repository-observation'
import { getRunApplyPreflight } from '@/shared/api/runs'
import { useInvalidationKey } from '@/shared/state/invalidation'
import { useLiveResource } from '@/shared/state/use-live-resource'

export function useApplyPreflight(runId: string, enabled: boolean) {
  const repos = useInvalidationKey('repos')
  return useLiveResource('repos', enabled ? runId : null, getRunApplyPreflight, {
    scope: repositoryConsumerKey({ runId }),
    refreshKey: repos,
    reconcileMs: REPOSITORY_RECONCILE_MS,
    leaseMs: REPOSITORY_FRESHNESS_MS,
    pauseWhenHidden: true,
  })
}
