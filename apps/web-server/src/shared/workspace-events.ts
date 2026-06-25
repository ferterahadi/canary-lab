import { EventEmitter } from 'events'
import type { DraftRecord } from '../features/wizard/logic/draft-store'
import type { EvaluationExportTaskView } from '../features/evaluation/logic/evaluation-export-store'

export type WorkspaceEvent =
  | { type: 'feature-created'; feature: string }
  | { type: 'feature-deleted'; feature: string }
  | { type: 'features-changed' }
  | { type: 'tests-changed'; feature: string }
  | { type: 'envsets-changed'; feature: string }
  | { type: 'coverage-changed'; feature: string }
  | { type: 'verification-config-changed'; feature: string }
  | { type: 'draft-created'; draft: DraftRecord }
  | { type: 'draft-updated'; draft: DraftRecord }
  | { type: 'draft-deleted'; draftId: string }
  | { type: 'evaluation-export-created'; task: EvaluationExportTaskView }
  | { type: 'evaluation-export-updated'; task: EvaluationExportTaskView }
  | { type: 'evaluation-export-deleted'; taskId: string }

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
