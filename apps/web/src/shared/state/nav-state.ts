import type { ConfigTab, PersistedView, RouteDialog, WorkspaceView } from '../lib/workspace-view-state'
import { type FeatureActivity } from '@/features/flights'
import type { FlightIndexEntry, FlightStageKey } from '../api/client'
import { FLIGHT_STAGE_KEYS } from '@shared/flights/types'

// The workspace's navigation state — what view is open, which feature / run /
// flight is selected, and which routed dialog is up. Lifted out of App so the
// non-trivial parts (dialog precedence, the activity→surface routing) are pure
// and unit-tested, and the state + URL persistence live in one hook
// (use-workspace-navigation) instead of a dozen useState in the 800-line shell.

/** The port-ification workflow view — an EMBEDDED surface (the Ports tab's
 *  active-workflow button, collision recovery, benchmark), never routed. The
 *  flight is NOT one of these any more: Parallel readiness drills to the Ports
 *  tab instead. 'new' starts a fresh workflow for a feature; 'revisit' reopens
 *  one by id. */
export type PortifyTarget =
  | { kind: 'new'; feature: string }
  | { kind: 'revisit'; workflowId: string }

/** R76: which job the flight launcher is open for. 're-fly' asks "where does the
 *  pipeline restart?" (the stage-entry picker); 'fresh' asks "what should this
 *  flight test?" — editable intent + repos, always a full restart. They're
 *  separate intents because a fresh input set INVALIDATES every mid-pipeline
 *  entry point, so offering both at once offers choices that cancel each other. */
export type FlightLauncherIntent = 'refly' | 'fresh'

export interface NavState {
  view: WorkspaceView
  feature: string | null
  run: string | null
  flight: string | null
  /** Which stage of the open flight is selected (routed as ?stage=…), or null
   *  for follow-mode — the flight detail then auto-picks the stage needing eyes.
   *  Lifted out of FlightDetail because a stage drill-through REPLACES the
   *  flight view: coming back remounted the detail, which re-ran the auto-pick
   *  and dropped the user on a different stage than they left. */
  flightStage: FlightStageKey | null
  /** The Feature-config dialog (routed as ?dialog=config), by feature. */
  configFor: string | null
  /** Which tab that dialog is on (routed as ?tab=…). Null = the entry point's
   *  own default; every opener that cares passes one (run detail → playwright,
   *  a flight's Parallel-readiness drill-through → ports). */
  configTab: ConfigTab | null
  /** The Verify-config dialog in the runs column (routed ?dialog=verification). */
  verifyOpen: boolean
  /** The flight stage-entry launcher (routed ?dialog=flight-start), by feature. */
  flightStartFor: string | null
  /** R76: the launcher opened in START-FRESH intent (routed ?dialog=flight-fresh)
   *  — same `flightStartFor` feature, but the dialog drops the stage menu and
   *  shows only the editable intent + repos. Set by the two "change what this
   *  flight tests" handoffs (the Repo-scan panel's Change…, the re-run dialog's
   *  Start fresh row); ignored unless `flightStartFor` is set. */
  flightStartFresh: boolean
  /** The new-flight launcher — intent + repo picker (routed ?dialog=flight-new). */
  flightStartNew: boolean
  /** The external authoring draft whose dialog is open (routed ?dialog=draft),
   *  by draft id. */
  draftFor: string | null
  /** The pre-flight a pill row reopened the new-flight dialog onto. */
  resumePlanTaskId: string | null
  /** The embedded portify workflow, if open. */
  portifyTarget: PortifyTarget | null
  /** R82: which failing test the run detail should land on, paired with the run
   *  it belongs to. Stored as a PAIR so selecting a different run makes the focus
   *  inert automatically — no clearing effect to keep in sync, and the run detail
   *  only honours a focus whose `runId` is the run it is showing. */
  focusTest: { runId: string; test: string } | null
  /** R83: the flight this view was drilled into FROM, or null when the user got
   *  here on their own. Set only by the flight's stage drill-throughs (coverage
   *  ledger, run detail), which switch the top-level view and would otherwise
   *  strand the user in the workspace. Routed as `from` — see PersistedView. */
  returnFlight: string | null
}

/** A URL stage name, or null when it isn't one of ours — an unknown/stale value
 *  reads as follow-mode rather than a blank pane. */
export function parseFlightStage(v: string | null): FlightStageKey | null {
  return v != null && (FLIGHT_STAGE_KEYS as readonly string[]).includes(v) ? (v as FlightStageKey) : null
}

/** Build the initial nav state from a hydrated PersistedView (URL/localStorage). */
export function initialNavState(persisted: PersistedView): NavState {
  return {
    view: persisted.view,
    feature: persisted.feature,
    run: persisted.run,
    flight: persisted.flight,
    flightStage: persisted.flight ? parseFlightStage(persisted.flightStage) : null,
    configFor: persisted.dialog === 'config' ? persisted.feature : null,
    configTab: persisted.dialog === 'config' ? persisted.configTab : null,
    verifyOpen: persisted.dialog === 'verification',
    flightStartFor: persisted.dialog === 'flight-start' || persisted.dialog === 'flight-fresh'
      ? persisted.feature
      : null,
    flightStartFresh: persisted.dialog === 'flight-fresh',
    flightStartNew: persisted.dialog === 'flight-new',
    draftFor: persisted.dialog === 'draft' ? persisted.draft : null,
    resumePlanTaskId: null,
    portifyTarget: null,
    focusTest: persisted.run && persisted.focusTest
      ? { runId: persisted.run, test: persisted.focusTest }
      : null,
    returnFlight: persisted.returnFlight,
  }
}

/** Which routed dialog owns the URL. Precedence follows z-order: the full-screen
 *  overlays (config > draft > flight-start > flight-new) sit above the in-column
 *  verify dialog, so the topmost open one wins. */
export function routedDialog(state: NavState): RouteDialog | null {
  if (state.configFor) return 'config'
  if (state.draftFor) return 'draft'
  if (state.flightStartFor) return state.flightStartFresh ? 'flight-fresh' : 'flight-start'
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
    flightStage: state.flightStage,
    draft: state.draftFor,
    configTab: state.configTab,
    // Only the CURRENT run's focus reaches the URL — a stale pair from a
    // previously-selected run is dropped rather than pinned.
    focusTest: state.focusTest?.runId === state.run ? state.focusTest.test : null,
    returnFlight: state.returnFlight,
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
