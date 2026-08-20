import { EventEmitter } from 'events'
import type { DraftRecord } from '../features/wizard/logic/draft-types'
import type { EvaluationExportTaskView } from '../features/evaluation/logic/evaluation-export-types'

export type WorkspaceEvent =
  | { type: 'feature-created'; feature: string }
  | { type: 'feature-deleted'; feature: string }
  /** A suite's `name` changed — its identity, so every surface keyed by the old
   *  name (selection, open dialogs, the URL, flight rows) must re-point at the
   *  new one rather than go blank. */
  | { type: 'feature-renamed'; from: string; to: string }
  | { type: 'features-changed' }
  | { type: 'tests-changed'; feature: string }
  | { type: 'envsets-changed'; feature: string }
  | { type: 'coverage-changed'; feature: string }
  | { type: 'tests-dirty-changed'; feature: string }
  | { type: 'verification-config-changed'; feature: string }
  | { type: 'journal-changed'; runId: string }
  | { type: 'draft-created'; draft: DraftRecord }
  | { type: 'draft-updated'; draft: DraftRecord }
  | { type: 'draft-deleted'; draftId: string }
  | { type: 'evaluation-export-created'; task: EvaluationExportTaskView }
  | { type: 'evaluation-export-updated'; task: EvaluationExportTaskView }
  | { type: 'evaluation-export-deleted'; taskId: string }
  // A newer canary-lab was found on the registry, or the self-update job changed
  // state (installing → done/failed). The client refetches GET /api/version.
  | { type: 'version-changed' }
  // A Flight manifest changed (stage transition, checkpoint, settle).
  // The client refetches the flight list / the open flight detail view.
  | { type: 'flights-changed' }
  // A spawned-agent record changed — started, ended, stopped, or reconciled to
  // `orphaned` on boot. The client refetches the agent jobs for the flight it has
  // open, so a live agent's stop control and a tombstone row appear without a
  // refresh.
  | { type: 'agent-jobs-changed'; jobId: string }
  // A pre-flight (plan-features) task changed — created, settled to a
  // proposal, auto-launched, or failed. The client refetches the pre-flight
  // list so the Flights pill's pre-flight rows update live.
  | { type: 'pre-flight-changed' }
  // canary-lab.config.json was written (PUT /api/project-config). The client
  // refetches it, so a workspace-level setting changed in one place lands
  // everywhere it is read without a refresh — the demo launcher's `showDemo`
  // being the first such setting to render outside the settings dialog itself.
  | { type: 'project-config-changed' }
  // The workspace-level Getting Started demo guard changed. The client
  // refetches /api/onboarding so internal and external starts share one truth.
  | { type: 'getting-started-changed' }

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
