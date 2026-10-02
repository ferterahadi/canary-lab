import type { CleanupResource } from '@shared/workspace-events'
import { useLiveResource } from '@/shared/state/use-live-resource'

export const CLEANUP_RECONCILE_MS = 15_000

/** Disk scans belong only to the visible cleanup tab; the shared reader owns
 * ordering, reconnect/focus recovery, and retention through read failures. */
export function useCleanupInventory<T>(resource: CleanupResource, read: () => Promise<T>, enabled = true) {
  const result = useLiveResource('cleanup', enabled ? resource : null, () => read(), {
    scope: resource,
    cache: `cleanup-${resource}`,
    retainOnError: true,
    reconcileMs: enabled ? CLEANUP_RECONCILE_MS : undefined,
    pauseWhenHidden: true,
  })
  return { ...result, initialLoading: result.value === null && result.error === null }
}
