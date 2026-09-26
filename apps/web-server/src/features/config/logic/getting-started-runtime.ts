import { isActiveFlightStatus, type FlightStatus } from '../../../../../../shared/flights/types'
import type { RunStore } from '../../runs/logic/run-store'
import type { FlightStore } from '../../flights/logic/store'
import type { PortifyStore } from '../../portify/logic/runtime/store'
import type { CoverageJobStore } from '../../coverage/logic/coverage/jobs/store'
import type { readDraft as readDraftRecord } from '../../wizard/logic/draft-store'
import type { readEvaluationExportTask } from '../../evaluation/logic/evaluation-export-store'
import type { WorkspaceEventBus } from '../../../shared/workspace-events'
import { GettingStartedSessionStore, isGettingStartedRunActive } from './getting-started-session'

interface GettingStartedRuntimeInput {
  logsDir: string
  runStore: Pick<RunStore, 'get' | 'onEvent' | 'offEvent'>
  flightStore: Pick<FlightStore, 'get' | 'onEvent' | 'offEvent'>
  portifyStore: Pick<PortifyStore, 'get' | 'onEvent' | 'offEvent'>
  coverageJobStore: Pick<CoverageJobStore, 'get'>
  workspaceEvents: Pick<WorkspaceEventBus, 'publish' | 'subscribe'>
  readDraft: (id: string) => ReturnType<typeof readDraftRecord>
  readExport: (id: string) => ReturnType<typeof readEvaluationExportTask>
}

/** Creates the one demo-session owner; start only after boot recovery has
 * finalized orphaned work, so reconciliation sees authoritative statuses. */
export function createGettingStartedRuntime({
  logsDir, runStore, flightStore, portifyStore, coverageJobStore,
  workspaceEvents, readDraft, readExport,
}: GettingStartedRuntimeInput) {
  const store = new GettingStartedSessionStore(logsDir, {
    status: (target) => {
      switch (target.kind) {
        case 'run': return runStore.get(target.id)?.manifest.status ?? null
        case 'flight': return flightStore.get(target.id)?.status ?? null
        case 'draft': return readDraft(target.id)?.status ?? null
        case 'coverage-job': return coverageJobStore.get(target.id)?.status ?? null
        case 'portify': return portifyStore.get(target.id)?.status ?? null
        case 'export': return readExport(target.id)?.status ?? null
      }
    },
    isActive: (target, status) => {
      switch (target.kind) {
        // NOT bare isActiveRunStatus: a queued demo run is still the demo's
        // target (see isGettingStartedRunActive) — the bare predicate settled
        // it as "completed: queued" and dropped the one-demo lock mid-run.
        case 'run': return isGettingStartedRunActive(status)
        // The cast is sound: a flight target's status comes from flightStore
        // (typed FlightStatus); the resolver's 'missing' fallback simply isn't
        // in ACTIVE_FLIGHT_STATUSES, so it reads as settled — the intent.
        case 'flight': return isActiveFlightStatus(status as FlightStatus)
        // Terminal draft statuses only — 'spec-ready' still awaits apply, so
        // the author demo stays claimed until the tests actually land.
        case 'draft': return !['accepted', 'cancelled', 'error'].includes(status)
        case 'coverage-job': return status === 'running'
        // 'ready-to-save' still awaits the save/cancel decision — the portify
        // demo isn't done until the overlay is captured or discarded.
        case 'portify': return !['saved', 'failed', 'aborted'].includes(status)
        case 'export': return status === 'running'
      }
    },
  }, () => workspaceEvents.publish({ type: 'getting-started-changed' }))
  const reconcile = () => store.reconcile()
  let unsubscribe: (() => void) | undefined

  function start(): void {
    store.reconcileInterrupted()
    runStore.onEvent(reconcile)
    flightStore.onEvent(reconcile)
    portifyStore.onEvent(reconcile)
    // Draft, coverage-job, and export-task mutations already reach the workspace
    // bus through their store bridges (both the GUI and MCP write through the
    // same shared stores), so the settle trigger rides those events instead of a
    // second per-store subscription. `getting-started-changed` itself is filtered
    // out — reconcile publishes it, so reacting to it would ping-pong (harmlessly,
    // since a settled state reconciles to a no-op, but pointlessly).
    unsubscribe = workspaceEvents.subscribe((event) => {
      if (
        event.type === 'draft-created' || event.type === 'draft-updated' || event.type === 'draft-deleted'
        || event.type === 'coverage-changed'
        || event.type === 'evaluation-export-created' || event.type === 'evaluation-export-updated' || event.type === 'evaluation-export-deleted'
      ) store.reconcile()
    })
  }

  function dispose(): void {
    runStore.offEvent(reconcile)
    flightStore.offEvent(reconcile)
    portifyStore.offEvent(reconcile)
    unsubscribe?.()
  }

  return { store, start, dispose }
}
