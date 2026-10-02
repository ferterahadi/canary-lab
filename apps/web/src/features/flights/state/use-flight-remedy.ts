import { REPOSITORY_FRESHNESS_MS, REPOSITORY_RECONCILE_MS, repositoryConsumerKey } from '@shared/repository-observation'
import { getFlightRemedy } from '@/shared/api/flights'
import { useInvalidationKey } from '@/shared/state/invalidation'
import { useLiveResource } from '@/shared/state/use-live-resource'

export function useFlightRemedy(flightId: string, detail: string) {
  const repos = useInvalidationKey('repos')
  const flights = useInvalidationKey('flights')
  const { value, ...resource } = useLiveResource('repos', JSON.stringify([flightId, detail]),
    (_key, opts) => getFlightRemedy(flightId, opts), {
      scope: repositoryConsumerKey({ flightId }),
      refreshKey: JSON.stringify([repos, flights]),
      reconcileMs: REPOSITORY_RECONCILE_MS,
      leaseMs: REPOSITORY_FRESHNESS_MS,
      pauseWhenHidden: true,
    })
  return { remedy: value?.remedy ?? null, ...resource }
}
