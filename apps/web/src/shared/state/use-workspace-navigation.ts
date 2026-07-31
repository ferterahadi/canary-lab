import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'
import {
  onViewChangedInOtherTab,
  persistView,
  readPersistedView,
  type ConfigTab,
  type RouteDialog,
  type WorkspaceView,
} from '../lib/workspace-view-state'
import {
  initialNavState,
  navToPersistedView,
  routedDialog,
  type FlightLauncherIntent,
  type NavState,
  type PortifyTarget,
} from './nav-state'
import type { FlightStageKey } from '../api/client'

// Owns the workspace navigation: the routed state, the URL/localStorage
// persistence, the cross-tab sync, and the selection-mirror refs the WS handler
// reads synchronously. App destructures this, so its body keeps using the same
// `selectedFeature` / `setView` / … names — the difference is the logic lives
// here (and is exercised through nav-state's pure tests) instead of inline in
// the 800-line shell. The individual dialog fields stay `useState` (proven
// behavior, minimal churn); the derivation + activity routing are the pure part.

const PERSISTED = readPersistedView()
const SEED = initialNavState(PERSISTED)

export interface WorkspaceNavigation {
  view: WorkspaceView
  selectedFeature: string | null
  selectedRunId: string | null
  selectedFlightId: string | null
  /** Which stage of the open flight is selected — null is follow-mode. Routed
   *  (?stage=…) so a drill-through's way back, and a refresh, land on the stage
   *  the user was actually on. */
  flightStage: FlightStageKey | null
  setFlightStage: (stage: FlightStageKey | null) => void
  configFor: string | null
  /** Which tab the config dialog is on (null = the default the mount picks). */
  configTab: ConfigTab | null
  verifyOpen: boolean
  flightStartFor: string | null
  flightStartFresh: boolean
  flightStartNew: boolean
  draftFor: string | null
  resumePlanTaskId: string | null
  portifyTarget: PortifyTarget | null
  routedDialog: RouteDialog | null
  setView: (v: WorkspaceView) => void
  setSelectedFeature: (f: string | null) => void
  setSelectedRunId: (r: string | null) => void
  setSelectedFlightId: (f: string | null) => void
  /** Open (feature) / close (null) the Feature-config dialog. `tab` picks which
   *  tab it lands on; omitting it resets to the mount's default, so a later
   *  open can't inherit the tab a previous one left behind. */
  setConfigFor: (f: string | null, tab?: ConfigTab | null) => void
  /** Follow the dialog's own tab switches into the route. */
  setConfigTab: (tab: ConfigTab) => void
  setVerifyOpen: (open: boolean) => void
  /** Open (feature) / close (null) the flight launcher. `intent` picks which job
   *  it opens for — 're-fly' (the stage-entry picker, default) or 'fresh' (edit
   *  intent + repos, full restart). Setting it always rewrites the intent, so a
   *  later re-fly can't inherit a stale fresh flag. */
  setFlightStartFor: (f: string | null, intent?: FlightLauncherIntent, fromStage?: FlightStageKey | null) => void
  /** R81: the stage a derived flight's "Continue from X" handed off — the
   *  launcher's default pick. Ephemeral (like `resumePlanTaskId`): it's a
   *  prefill, not a location, and a cold load without it still opens a coherent
   *  dialog on the re-entry picker. */
  flightStartStage: FlightStageKey | null
  setFlightStartNew: (open: boolean) => void
  /** Open (id) / close (null) the external authoring-draft dialog. */
  setDraftFor: (id: string | null) => void
  setResumePlanTaskId: (id: string | null) => void
  setPortifyTarget: (t: PortifyTarget | null) => void
  /** Open a flight's detail (null = the flights landing list). */
  openFlight: (flightId: string | null) => void
  /** Select a run in the workspace (clears any pending selection guard).
   *  `focusTest` (R82) is a run-summary failed-entry name: the run detail opens on
   *  its Playwright tab, scrolled to that test. `fromFlight` (R83) is the flight
   *  that drilled here — omit it and any previous origin is cleared, so only a
   *  real drill-through leaves a way back. */
  navigateToRun: (feature: string, runId: string, focusTest?: string, fromFlight?: string | null) => void
  /** Open a feature's coverage ledger. `fromFlight` (R83) follows the same rule
   *  as navigateToRun's: set by the flight's drill-through, cleared otherwise. */
  navigateToCoverage: (feature: string, fromFlight?: string | null) => void
  /** R83: the flight a drill-through came from, or null. Drives the coverage
   *  ledger's Close and the top bar's return chip. */
  returnFlight: string | null
  /** R82: which failing test the open run detail should land on, or null. Paired
   *  with its run so a stale focus can never apply to a different one. */
  focusTest: { runId: string; test: string } | null
  /** Select a freshly-started run into the detail pane (seeds the pending ref). */
  selectStartedRun: (runId: string) => void
  /** Mirror refs read synchronously by the WS handler / refreshFeatures so those
   *  stable callbacks don't close over changing state. */
  pendingRunSelectionRef: MutableRefObject<string | null>
  selectedFeatureRef: MutableRefObject<string | null>
  selectedRunIdRef: MutableRefObject<string | null>
}

export function useWorkspaceNavigation(): WorkspaceNavigation {
  const [view, setView] = useState<WorkspaceView>(SEED.view)
  const [selectedFeature, setSelectedFeature] = useState<string | null>(SEED.feature)
  const [selectedRunId, setSelectedRunId] = useState<string | null>(SEED.run)
  const [selectedFlightId, setSelectedFlightId] = useState<string | null>(SEED.flight)
  const [flightStage, setFlightStage] = useState<FlightStageKey | null>(SEED.flightStage)
  const [configFor, setConfigForState] = useState<string | null>(SEED.configFor)
  const [configTab, setConfigTab] = useState<ConfigTab | null>(SEED.configTab)
  // One opener for the dialog + its tab so the tab can never outlive the open
  // that set it (the same rule setFlightStartFor follows for its intent flag).
  const setConfigFor = useCallback((f: string | null, tab: ConfigTab | null = null) => {
    setConfigForState(f)
    setConfigTab(f !== null ? tab : null)
  }, [])
  const [verifyOpen, setVerifyOpen] = useState<boolean>(SEED.verifyOpen)
  const [flightStartFor, setFlightStartForState] = useState<string | null>(SEED.flightStartFor)
  const [flightStartFresh, setFlightStartFresh] = useState<boolean>(SEED.flightStartFresh)
  const [flightStartNew, setFlightStartNew] = useState<boolean>(SEED.flightStartNew)

  // One opener for both launcher intents so the fresh flag can never outlive the
  // handoff that set it (a later re-fly would otherwise inherit it).
  const [flightStartStage, setFlightStartStage] = useState<FlightStageKey | null>(null)
  const setFlightStartFor = useCallback((f: string | null, intent: FlightLauncherIntent = 'refly', fromStage: FlightStageKey | null = null) => {
    setFlightStartForState(f)
    setFlightStartFresh(f !== null && intent === 'fresh')
    setFlightStartStage(f !== null ? fromStage : null)
  }, [])
  const [draftFor, setDraftFor] = useState<string | null>(SEED.draftFor)
  const [resumePlanTaskId, setResumePlanTaskId] = useState<string | null>(SEED.resumePlanTaskId)
  const [portifyTarget, setPortifyTarget] = useState<PortifyTarget | null>(SEED.portifyTarget)
  const [focusTest, setFocusTest] = useState<NavState['focusTest']>(SEED.focusTest)
  const [returnFlight, setReturnFlight] = useState<string | null>(SEED.returnFlight)

  const pendingRunSelectionRef = useRef<string | null>(PERSISTED.run)
  const selectedFeatureRef = useRef<string | null>(null)
  const selectedRunIdRef = useRef<string | null>(PERSISTED.run)
  // Read synchronously by openFlight, which must tell "same flight, coming back"
  // apart from "a different flight" without taking a changing dep.
  const selectedFlightIdRef = useRef<string | null>(SEED.flight)
  useEffect(() => { selectedFeatureRef.current = selectedFeature }, [selectedFeature])
  useEffect(() => { selectedRunIdRef.current = selectedRunId }, [selectedRunId])
  useEffect(() => { selectedFlightIdRef.current = selectedFlightId }, [selectedFlightId])

  const state: NavState = {
    view,
    feature: selectedFeature,
    run: selectedRunId,
    flight: selectedFlightId,
    flightStage,
    configFor,
    configTab,
    verifyOpen,
    flightStartFor,
    flightStartFresh,
    flightStartNew,
    draftFor,
    resumePlanTaskId,
    portifyTarget,
    focusTest,
    returnFlight,
  }
  const dialog = routedDialog(state)

  // Persist the full route to the URL on every change (durable tier also mirrors
  // to localStorage for cross-tab sync).
  useEffect(() => {
    persistView(navToPersistedView(state))
    // Intentionally keyed on the primitive fields, not the freshly-built `state`
    // object (new identity every render).
    // draftFor is listed explicitly: the `dialog` value stays 'draft' when the
    // open draft changes id-to-id, so keying on `dialog` alone would leave the
    // URL's `draft` param stale. configTab is listed for the same reason — the
    // dialog stays 'config' while the user switches tabs inside it.
     
    // focusTest is listed for the same reason as draftFor/configTab: the run
    // stays the same while the focused test changes, so keying on selectedRunId
    // alone would leave the URL's `test` param stale.
  }, [view, selectedFeature, selectedRunId, dialog, selectedFlightId, flightStage, draftFor, configTab, focusTest, returnFlight])

  // Cross-tab: another tab's durable-tier change (view + feature) pushes here.
  useEffect(() => onViewChangedInOtherTab((s) => {
    setView(s.view)
    if (s.feature) setSelectedFeature(s.feature)
  }), [])

  const openFlight = useCallback((flightId: string | null) => {
    // A stage pick belongs to the flight it was made on, so opening a DIFFERENT
    // flight returns to follow-mode. Re-opening the SAME one keeps it — that
    // call is a drill-through's way back, and dropping the stage there is the
    // bug this exists to fix.
    if (flightId !== selectedFlightIdRef.current) setFlightStage(null)
    setSelectedFlightId(flightId)
    setView('flights')
    // Arriving at a flight IS the return — drop the origin so the way back
    // can't outlive the trip that set it.
    setReturnFlight(null)
  }, [])

  const navigateToRun = useCallback((feature: string, runId: string, focus?: string, fromFlight: string | null = null) => {
    pendingRunSelectionRef.current = null
    setSelectedFeature(feature)
    setSelectedRunId(runId)
    // Always written, so navigating to a run WITHOUT a focus clears a previous
    // one instead of inheriting it.
    setFocusTest(focus ? { runId, test: focus } : null)
    // Same rule for the origin: an arrival that names no flight clears one a
    // previous drill-through left behind.
    setReturnFlight(fromFlight)
    setView('workspace')
  }, [])

  const navigateToCoverage = useCallback((feature: string, fromFlight: string | null = null) => {
    setSelectedFeature(feature)
    setReturnFlight(fromFlight)
    setView('coverage')
  }, [])

  const selectStartedRun = useCallback((runId: string) => {
    pendingRunSelectionRef.current = runId
    setSelectedRunId(runId)
  }, [])

  return {
    view,
    selectedFeature,
    selectedRunId,
    selectedFlightId,
    flightStage,
    setFlightStage,
    configFor,
    configTab,
    verifyOpen,
    flightStartFor,
    flightStartFresh,
    flightStartStage,
    flightStartNew,
    draftFor,
    resumePlanTaskId,
    portifyTarget,
    focusTest,
    routedDialog: dialog,
    setView,
    setSelectedFeature,
    setSelectedRunId,
    setSelectedFlightId,
    setConfigFor,
    setConfigTab,
    setVerifyOpen,
    setFlightStartFor,
    setFlightStartNew,
    setDraftFor,
    setResumePlanTaskId,
    setPortifyTarget,
    openFlight,
    navigateToRun,
    navigateToCoverage,
    returnFlight,
    selectStartedRun,
    pendingRunSelectionRef,
    selectedFeatureRef,
    selectedRunIdRef,
  }
}
