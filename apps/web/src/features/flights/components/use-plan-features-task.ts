import * as flightsApi from '@/shared/api/flights'
import * as internalApi from '@/shared/api/internal'
import type { PlanFeaturesTask } from '@shared/flights/types'
import { useLiveResource } from '@/shared/state/use-live-resource'

type PlanningValue = { kind: 'task'; task: PlanFeaturesTask } | { kind: 'missing' }

/** Unknown reads retry; an authoritative deletion settles until invalidated. */
export function usePlanFeaturesTask(taskId: string | null, seed?: PlanFeaturesTask) {
  const resource = useLiveResource<PlanningValue>('pre-flights', taskId, async (id) => {
    try {
      return { kind: 'task', task: await flightsApi.getPlanFeaturesTask(id) }
    } catch (error) {
      if (error instanceof internalApi.ApiError && error.status === 404) return { kind: 'missing' }
      throw error
    }
  }, {
    cache: 'pre-flight-task',
    pollIntervalMs: 1500,
    pollWhile: (value) => value === null || (value.kind === 'task' && value.task.status === 'running'),
    seed: seed ? { key: seed.taskId, value: { kind: 'task', task: seed } } : undefined,
  })
  return {
    task: resource.value?.kind === 'task' ? resource.value.task : null,
    error: resource.value?.kind === 'missing' ? 'This planning task no longer exists.' : resource.error,
  }
}
