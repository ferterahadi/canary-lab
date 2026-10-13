import type { WorkspaceEvent } from '../../../../../shared/workspace-events'
import type { WorkspaceEventPublisher } from '../workspace-events'

/**
 * An in-memory publisher that appends every event to `events`. Pass the test's
 * own array when it already holds one; the same array is returned either way.
 */
export function captureEvents(events: WorkspaceEvent[] = []): WorkspaceEventPublisher & { events: WorkspaceEvent[] } {
  return { events, publish: (event) => { events.push(event) } }
}
