import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'
import {
  onViewChangedInOtherTab,
  persistView,
  readPersistedView,
  type RouteDialog,
  type WorkspaceView,
} from '../lib/workspace-view-state'
import { initialNavState, navToPersistedView, routedDialog, type NavState, type PortifyTarget } from './nav-state'

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
  configFor: string | null
  verifyOpen: boolean
  flightStartFor: string | null
  flightStartNew: boolean
  draftFor: string | null
  resumePlanTaskId: string | null
  portifyTarget: PortifyTarget | null
  routedDialog: RouteDialog | null
  setView: (v: WorkspaceView) => void
  setSelectedFeature: (f: string | null) => void
  setSelectedRunId: (r: string | null) => void
  setSelectedFlightId: (f: string | null) => void
  setConfigFor: (f: string | null) => void
  setVerifyOpen: (open: boolean) => void
  setFlightStartFor: (f: string | null) => void
  setFlightStartNew: (open: boolean) => void
  /** Open (id) / close (null) the external authoring-draft dialog. */
  setDraftFor: (id: string | null) => void
  setResumePlanTaskId: (id: string | null) => void
  setPortifyTarget: (t: PortifyTarget | null) => void
  /** Open a flight's detail (null = the flights landing list). */
  openFlight: (flightId: string | null) => void
  /** Select a run in the workspace (clears any pending selection guard). */
  navigateToRun: (feature: string, runId: string) => void
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
  const [configFor, setConfigFor] = useState<string | null>(SEED.configFor)
  const [verifyOpen, setVerifyOpen] = useState<boolean>(SEED.verifyOpen)
  const [flightStartFor, setFlightStartFor] = useState<string | null>(SEED.flightStartFor)
  const [flightStartNew, setFlightStartNew] = useState<boolean>(SEED.flightStartNew)
  const [draftFor, setDraftFor] = useState<string | null>(SEED.draftFor)
  const [resumePlanTaskId, setResumePlanTaskId] = useState<string | null>(SEED.resumePlanTaskId)
  const [portifyTarget, setPortifyTarget] = useState<PortifyTarget | null>(SEED.portifyTarget)

  const pendingRunSelectionRef = useRef<string | null>(PERSISTED.run)
  const selectedFeatureRef = useRef<string | null>(null)
  const selectedRunIdRef = useRef<string | null>(PERSISTED.run)
  useEffect(() => { selectedFeatureRef.current = selectedFeature }, [selectedFeature])
  useEffect(() => { selectedRunIdRef.current = selectedRunId }, [selectedRunId])

  const state: NavState = {
    view,
    feature: selectedFeature,
    run: selectedRunId,
    flight: selectedFlightId,
    configFor,
    verifyOpen,
    flightStartFor,
    flightStartNew,
    draftFor,
    resumePlanTaskId,
    portifyTarget,
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
    // URL's `draft` param stale.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, selectedFeature, selectedRunId, dialog, selectedFlightId, draftFor])

  // Cross-tab: another tab's durable-tier change (view + feature) pushes here.
  useEffect(() => onViewChangedInOtherTab((s) => {
    setView(s.view)
    if (s.feature) setSelectedFeature(s.feature)
  }), [])

  const openFlight = useCallback((flightId: string | null) => {
    setSelectedFlightId(flightId)
    setView('flights')
  }, [])

  const navigateToRun = useCallback((feature: string, runId: string) => {
    pendingRunSelectionRef.current = null
    setSelectedFeature(feature)
    setSelectedRunId(runId)
    setView('workspace')
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
    configFor,
    verifyOpen,
    flightStartFor,
    flightStartNew,
    draftFor,
    resumePlanTaskId,
    portifyTarget,
    routedDialog: dialog,
    setView,
    setSelectedFeature,
    setSelectedRunId,
    setSelectedFlightId,
    setConfigFor,
    setVerifyOpen,
    setFlightStartFor,
    setFlightStartNew,
    setDraftFor,
    setResumePlanTaskId,
    setPortifyTarget,
    openFlight,
    navigateToRun,
    selectStartedRun,
    pendingRunSelectionRef,
    selectedFeatureRef,
    selectedRunIdRef,
  }
}
