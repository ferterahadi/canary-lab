import { EventEmitter } from 'events'
import type { WorkspaceEvent } from '../../../../shared/workspace-events'

export interface WorkspaceEventPublisher {
  publish(event: WorkspaceEvent): void
}

export class WorkspaceEventBus implements WorkspaceEventPublisher {
  // Broadcast bus: one 'event' listener per connected client, each removed on
  // disconnect. The fan-out is unbounded by design, so disable Node's default
  // 10-listener cap (which otherwise warns once >10 clients connect at once).
  private readonly emitter = new EventEmitter().setMaxListeners(0)

  publish(event: WorkspaceEvent): void {
    this.emitter.emit('event', event)
  }

  subscribe(listener: (event: WorkspaceEvent) => void): () => void {
    this.emitter.on('event', listener)
    return () => this.emitter.off('event', listener)
  }
}

export function publishWorkspaceEvent(
  publisher: WorkspaceEventPublisher | undefined,
  event: WorkspaceEvent,
): void {
  publisher?.publish(event)
}
