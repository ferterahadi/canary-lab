import type { CleanupResource } from '../../../../shared/workspace-events'
import { bridgeStoreEvents, type StoreEventSource } from './store-event-bridge'
import type { WorkspaceEventPublisher } from './workspace-events'

export const CLEANUP_EVENT_COALESCE_MS = 2500

/** One bridge per inventory owner, shared by REST, MCP and background writes.
 * Coalesce progress writes because inventory readers also measure disk usage. */
export function bridgeCleanupEvents<E>(source: StoreEventSource<E>, events: WorkspaceEventPublisher, resources: CleanupResource[]): void {
  for (const resource of resources) {
    bridgeStoreEvents(source, events, () => ({ type: 'cleanup-changed', resource }), {
      coalesceMs: CLEANUP_EVENT_COALESCE_MS,
    })
  }
}
