import { createContext, useCallback, useContext, type ReactNode } from 'react'
import type { FlightStageKey } from '@shared/flights/types'
import { useWorkspaceFlights } from './features/flights/state/use-workspace-flights'
import { resolveFeatureFlightTarget } from './features/flights/components/FlightChipState'
import { stageRowKey } from './features/flights/components/StageRail'
import type { FeatureActivity } from './features/flights/state/feature-activity'
import { useRuns } from './features/runs/state/RunsContext'
import { useInvalidation } from './shared/state/invalidation'
import { resolveActivityTarget, type FlightLauncherIntent } from './shared/state/nav-state'
import { useWorkspaceData } from './shared/state/use-workspace-data'
import { useWorkspaceNavigation } from './shared/state/use-workspace-navigation'
import { useWorkspaceSelection } from './shared/state/use-workspace-selection'
import { WorkspaceActionsProvider } from './shared/state/workspace-actions'
import { WorkStateProvider } from './shared/state/work-state'

// The workspace's state, built once above App: the URL (navigation), what is
// selected, the suites and flights, and the live work on them, plus the
// navigation actions that combine those. App reads it through `useWorkspace`
// to lay out the screen; leaves several components down read the narrower
// WorkState and WorkspaceActions contexts this provider fills, so App no
// longer hands them its values.
//
// Each hook runs exactly once per workspace, in the order App ran them: the
// navigation hook is the only URL writer, and `useWorkspaceFlights` owns the
// coverage-job effect that must not run twice.

function useWorkspaceState() {
  const nav = useWorkspaceNavigation()
  const {
    configFor, setConfigFor, configTab, setSelectedFeature, selectedFeature, selectedRunId, setSelectedRunId,
    openFlight, setFlightStage, setFlightStartFor, setFlightStartNew, setResumePlanTaskId, navigateToRun,
    pendingRunSelectionRef, selectedFeatureRef, selectedRunIdRef,
  } = nav

  // Runs come from the WebSocket-backed RunsProvider — no polling here. `runs`
  // is the full index across all features; the per-feature filter happens in
  // the selection hook.
  const { runs: allRuns } = useRuns()
  const { invalidate } = useInvalidation()

  const selection = useWorkspaceSelection({
    allRuns, selectedFeature, selectedRunId, setSelectedFeature, setSelectedRunId,
    selectedFeatureRef, selectedRunIdRef, pendingRunSelectionRef,
  })

  // The data hook owns fetches and workspace events; selection stays with
  // the controller above so reconnects and manual navigation use one policy.
  const data = useWorkspaceData({
    invalidate,
    onInitialFeatures: selection.onInitialFeatures,
    onFeaturesRefreshed: selection.onFeaturesRefreshed,
    selectedFeatureRef,
    selectedRunIdRef,
    // A rename anywhere (this tab, another tab, an MCP client) must move the
    // open config dialog with the suite instead of leaving it on a name the
    // server no longer resolves.
    onFeatureRenamed: (from, to) => { if (configFor === from) setConfigFor(to, configTab) },
  })
  const { features, flights, refreshFeatures, flightsRef } = data

  const invalidateCoverage = useCallback(() => invalidate('coverage'), [invalidate])
  const work = useWorkspaceFlights({ features, flights, selectedFeature, refreshFeatures, invalidateCoverage })

  const openFlightStage = useCallback((flightId: string, stage: FlightStageKey): void => {
    openFlight(flightId)
    // Opening a different flight resets its stage, so set the destination after.
    setFlightStage(stageRowKey(stage))
  }, [openFlight, setFlightStage])

  const openFeatureStage = useCallback((feature: string, stage: FlightStageKey): void => {
    setSelectedFeature(feature)
    openFlightStage(resolveFeatureFlightTarget(feature, flightsRef.current).flightId, stage)
  }, [flightsRef, openFlightStage, setSelectedFeature])

  // Portify is a Flight stage, regardless of whether a conductor record exists.
  const openPortifyStage = useCallback((feature: string): void => {
    setConfigFor(null)
    openFeatureStage(feature, 'portify')
  }, [openFeatureStage, setConfigFor])

  // Clicking a live activity row opens the activity's REAL surface: its flight,
  // on the stage that owns it. The routing decision is the pure
  // `resolveActivityTarget`; this maps the target to nav.
  const openActivity = useCallback((feature: string, activity: FeatureActivity) => {
    const target = resolveActivityTarget(feature, activity, flightsRef.current)
    openFlightStage(target.flightId, target.stage)
  }, [openFlightStage, flightsRef])

  const openPickedFlight = useCallback((id: string | null, stage?: FlightStageKey): void => {
    if (id && stage) openFlightStage(id, stage); else openFlight(id)
  }, [openFlight, openFlightStage])

  const openPreFlight = useCallback((taskId: string): void => {
    setResumePlanTaskId(taskId)
    setFlightStartNew(true)
  }, [setResumePlanTaskId, setFlightStartNew])

  // Select the feature too: the launcher is qualified by the durable `feature`
  // param, so opening it for a feature while a DIFFERENT one is selected would
  // deep-link to the wrong suite.
  const startFlight = useCallback((feature: string, intent?: FlightLauncherIntent, fromStage?: FlightStageKey | null): void => {
    setSelectedFeature(feature)
    setFlightStartFor(feature, intent, fromStage)
  }, [setSelectedFeature, setFlightStartFor])

  return {
    nav, selection, data, work, invalidateCoverage,
    openFlightStage, openFeatureStage, openPortifyStage, openActivity, openPickedFlight, openPreFlight, startFlight,
  }
}

export type Workspace = ReturnType<typeof useWorkspaceState>

const WorkspaceContext = createContext<Workspace | null>(null)

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const workspace = useWorkspaceState()
  const { nav, data, work } = workspace
  return (
    <WorkspaceContext.Provider value={workspace}>
      <WorkspaceActionsProvider
        openFlight={workspace.openPickedFlight}
        openActivity={workspace.openActivity}
        startFlight={workspace.startFlight}
        openPreFlight={workspace.openPreFlight}
        navigateToRun={nav.navigateToRun}
        openPortifyStage={workspace.openPortifyStage}
        openReview={nav.openReview}
      >
        <WorkStateProvider
          flights={data.flights}
          preFlights={data.preFlights}
          activity={work.activity}
          externalHistory={work.externalHistory}
          coverageJobs={work.coverageJobs}
          portifyWorkflows={work.portifyWorkflows}
          derivedStages={work.derivedStages}
          pickerFeatures={work.pickerFeatures}
        >
          {children}
        </WorkStateProvider>
      </WorkspaceActionsProvider>
    </WorkspaceContext.Provider>
  )
}

/** The whole workspace state, for the layout that composes it. Unlike the
 *  narrow contexts there is no useful empty value: without the provider there
 *  is no URL state to lay out. */
export function useWorkspace(): Workspace {
  const workspace = useContext(WorkspaceContext)
  if (!workspace) throw new Error('useWorkspace must be used inside WorkspaceProvider')
  return workspace
}
