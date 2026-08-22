import type { ConfigTab, PersistedView, RouteDialog, RunArrivalTab, WorkspaceView } from '../lib/workspace-view-state'
import { ACTIVITY_STAGE, derivedFlightToken, type FeatureActivity } from '@/features/flights'
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
  /** The Getting Started guide (routed ?dialog=demo). Opens itself once on a
   *  workspace that has never run anything; afterwards it is reached from the
   *  status bar. The route key stays `demo` for existing deep links. */
  demoOpen: boolean
  /** Project Settings (routed ?dialog=settings) — the features column's gear.
   *  Workspace-scoped, so it needs no id qualifier. */
  settingsOpen: boolean
  /** The pre-flight a pill row reopened the new-flight dialog onto. */
  resumePlanTaskId: string | null
  /** The embedded portify workflow, if open. */
  portifyTarget: PortifyTarget | null
  /** R82: which failing test the run detail should land on, paired with the run
   *  it belongs to. Stored as a PAIR so selecting a different run makes the focus
   *  inert automatically — no clearing effect to keep in sync, and the run detail
   *  only honours a focus whose `runId` is the run it is showing. */
  focusTest: { runId: string; test: string } | null
  /** Which run-detail tab a drill-through asked for, paired with its run for the
   *  same reason `focusTest` is: a tab intent that outlived the run it was meant
   *  for would silently reroute the next run the user opens. The flight's Test
   *  Run stage sets it when the run's captured fixes are clicked. */
  runTab: { runId: string; tab: RunArrivalTab } | null
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
    demoOpen: persisted.dialog === 'demo',
    settingsOpen: persisted.dialog === 'settings',
    resumePlanTaskId: null,
    portifyTarget: null,
    focusTest: persisted.run && persisted.focusTest
      ? { runId: persisted.run, test: persisted.focusTest }
      : null,
    runTab: persisted.run && persisted.runTab
      ? { runId: persisted.run, tab: persisted.runTab }
      : null,
    returnFlight: persisted.returnFlight,
  }
}

/** Which routed dialog owns the URL. Precedence follows z-order: the full-screen
 *  overlays (config > draft > flight-start > flight-new > demo) sit above the
 *  in-column verify dialog, so the topmost open one wins.
 *
 *  `demo` ranks BELOW flight-new deliberately: its own "Start a flight" action
 *  opens that launcher, and for the moment both are open the URL must name the
 *  launcher — the thing the user is actually looking at.
 *
 *  `settings` ranks LAST for the same reason it is listed last: it mounts inside
 *  the features column, the first column App renders, so every other overlay in
 *  the tree paints over it. Two of these being open at once is a corner nobody
 *  can reach through the UI — the ordering just keeps the URL naming whatever
 *  would actually be on top if they were. */
export function routedDialog(state: NavState): RouteDialog | null {
  if (state.configFor) return 'config'
  if (state.draftFor) return 'draft'
  if (state.flightStartFor) return state.flightStartFresh ? 'flight-fresh' : 'flight-start'
  if (state.flightStartNew) return 'flight-new'
  if (state.demoOpen) return 'demo'
  if (state.verifyOpen) return 'verification'
  if (state.settingsOpen) return 'settings'
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
    runTab: state.runTab?.runId === state.run ? state.runTab.tab : null,
    returnFlight: state.returnFlight,
  }
}

/** Where clicking a live activity row should land — the pure decision behind
 *  openActivity. Always resolves to a surface: the flight detail is the
 *  universal fallback, so no state can make a row unclickable. `flights`
 *  resolves the feature's flight record; features without one open their
 *  DERIVED flight (the `feature:` token). */
export type ActivityTarget =
  | { kind: 'run'; feature: string; runId: string }
  | { kind: 'flight'; flightId: string; stage?: FlightStageKey }
  | { kind: 'portify'; workflowId: string }
  | { kind: 'draft'; draftId: string }

export function resolveActivityTarget(
  feature: string,
  activity: FeatureActivity,
  flights: readonly FlightIndexEntry[],
): ActivityTarget {
  // The flight view, pinned to the stage the live job belongs to — NOT the bare
  // run/export detail. A feature used to route two different ways depending on
  // whether a run happened to be live: idle rows opened the (derived) flight
  // page, running rows opened the run. Same row, same feature, destination
  // decided by timing. The flight view is the superset — it shows setup and
  // every other stage, and the pinned stage lands on the live one directly.
  //
  // A feature with no flight record still gets a flight: its `feature:` derived
  // token (R81). Before this, an `exporting` row on a flightless feature routed
  // to `flightId: null` — the flights LANDING list — so the one row the user
  // clicked to watch an export in progress was the one row that couldn't reach
  // the flight page at all.
  const flightTarget = (stage: FlightStageKey): ActivityTarget => {
    const flight = flights.find((f) => f.feature === feature)
    return { kind: 'flight', flightId: flight ? flight.flightId : derivedFlightToken(feature), stage }
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
  // Every remaining case — an export, or a verb whose own id is missing (an
  // older server, or a job caught mid-write) — opens the flight at the stage
  // that verb belongs to. Monitoring is always one click away.
  return flightTarget(ACTIVITY_STAGE[activity.kind])
}
