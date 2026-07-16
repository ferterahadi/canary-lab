import type { PersistedView, RouteDialog, WorkspaceView } from '../lib/workspace-view-state'
import type { FeatureActivity } from '../../features/flights/state/feature-activity'
import type { FlightIndexEntry } from '../api/client'

// The workspace's navigation state — what view is open, which feature / run /
// flight is selected, and which routed dialog is up. Lifted out of App so the
// non-trivial parts (dialog precedence, the activity→surface routing) are pure
// and unit-tested, and the state + URL persistence live in one hook
// (use-workspace-navigation) instead of a dozen useState in the 800-line shell.

/** The port-ification workflow view — an EMBEDDED surface (flight drill-through,
 *  collision recovery, benchmark), never routed. 'new' starts a fresh workflow
 *  for a feature; 'revisit' reopens one by id. */
export type PortifyTarget =
  | { kind: 'new'; feature: string }
  | { kind: 'revisit'; workflowId: string }

export interface NavState {
  view: WorkspaceView
  feature: string | null
  run: string | null
  flight: string | null
  /** The Feature-config dialog (routed as ?dialog=config), by feature. */
  configFor: string | null
  /** The Verify-config dialog in the runs column (routed ?dialog=verification). */
  verifyOpen: boolean
  /** The flight stage-entry launcher (routed ?dialog=flight-start), by feature. */
  flightStartFor: string | null
  /** The new-flight launcher — intent + repo picker (routed ?dialog=flight-new). */
  flightStartNew: boolean
  /** The external authoring draft whose dialog is open (routed ?dialog=draft),
   *  by draft id. */
  draftFor: string | null
  /** The pre-flight a pill row reopened the new-flight dialog onto. */
  resumePlanTaskId: string | null
  /** The embedded portify workflow, if open. */
  portifyTarget: PortifyTarget | null
}

/** Build the initial nav state from a hydrated PersistedView (URL/localStorage). */
export function initialNavState(persisted: PersistedView): NavState {
  return {
    view: persisted.view,
    feature: persisted.feature,
    run: persisted.run,
    flight: persisted.flight,
    configFor: persisted.dialog === 'config' ? persisted.feature : null,
    verifyOpen: persisted.dialog === 'verification',
    flightStartFor: persisted.dialog === 'flight-start' ? persisted.feature : null,
    flightStartNew: persisted.dialog === 'flight-new',
    draftFor: persisted.dialog === 'draft' ? persisted.draft : null,
    resumePlanTaskId: null,
    portifyTarget: null,
  }
}

/** Which routed dialog owns the URL. Precedence follows z-order: the full-screen
 *  overlays (config > draft > flight-start > flight-new) sit above the in-column
 *  verify dialog, so the topmost open one wins. */
export function routedDialog(state: NavState): RouteDialog | null {
  if (state.configFor) return 'config'
  if (state.draftFor) return 'draft'
  if (state.flightStartFor) return 'flight-start'
  if (state.flightStartNew) return 'flight-new'
  if (state.verifyOpen) return 'verification'
  return null
}

/** Serialize the nav state to the shape the URL/localStorage persister wants. */
export function navToPersistedView(state: NavState): PersistedView {
  return {
    view: state.view,
    feature: state.feature,
    run: state.run,
    dialog: routedDialog(state),
    flight: state.flight,
    draft: state.draftFor,
  }
}

/** Where clicking a live activity row should land — the pure decision behind
 *  openActivity. Returns null for an activity that has no surface to open (e.g.
 *  a running verb with no runId). `flights` resolves a feature's flight record
 *  for the export case. */
export type ActivityTarget =
  | { kind: 'run'; feature: string; runId: string }
  | { kind: 'flight'; flightId: string | null }
  | { kind: 'portify'; workflowId: string }
  | { kind: 'draft'; draftId: string }

export function resolveActivityTarget(
  feature: string,
  activity: FeatureActivity,
  flights: readonly FlightIndexEntry[],
): ActivityTarget | null {
  if (activity.kind === 'running' && activity.runId) {
    return { kind: 'run', feature, runId: activity.runId }
  }
  if (activity.kind === 'exporting') {
    // R29/R38: a flightless export is watched from the flights view (run detail
    // no longer hosts an inline panel); a feature with a flight opens that flight.
    const flight = flights.find((f) => f.feature === feature)
    return { kind: 'flight', flightId: flight ? flight.flightId : null }
  }
  if (activity.kind === 'portifying' && activity.workflowId) {
    return { kind: 'portify', workflowId: activity.workflowId }
  }
  if (activity.kind === 'authoring' && activity.draftId) {
    // The authoring verb is always an external MCP draft — open its own routed
    // dialog (the live agent session + cleanup controls). Routing to the flights
    // view (the old R36 behavior) dead-ended: from the picker it just reopened
    // the picker, and there was no draft surface mounted at all.
    return { kind: 'draft', draftId: activity.draftId }
  }
  return null
}
