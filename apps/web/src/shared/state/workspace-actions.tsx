import { createContext, useContext, useMemo, type ReactNode } from 'react'
import type { FlightStageKey } from '@shared/flights/types'
import type { ReviewFocus, RunOpenTarget } from '../lib/workspace-view-state'
import type { FlightLauncherIntent } from './nav-state'
import type { FeatureActivity } from '@/features/flights/state/feature-activity'

// The workspace's navigation actions, for leaves that sit several components
// below App. Every callback is optional on purpose: a leaf renders an
// affordance only when its action is present, so a subtree mounted without the
// provider (a unit test, or a surface App never wires) keeps hiding it exactly
// as an omitted prop did. The URL is still written only by
// `use-workspace-navigation.ts` — these are the callbacks it already exposes.

export interface WorkspaceActions {
  /** Open a flight's detail (null = the flights list), on `stage` when named. */
  openFlight?: (flightId: string | null, stage?: FlightStageKey) => void
  /** Open the real surface behind a live activity row. */
  openActivity?: (feature: string, activity: FeatureActivity) => void
  /** Open the flight launcher for a suite; `intent` and `fromStage` default to
   *  the re-entry picker with no pre-picked stage. */
  startFlight?: (feature: string, intent?: FlightLauncherIntent, fromStage?: FlightStageKey | null) => void
  /** Reopen the new-flight dialog attached to a pre-flight task. */
  openPreFlight?: (taskId: string) => void
  navigateToRun?: (feature: string, runId: string, target?: RunOpenTarget, fromFlight?: string | null) => void
  /** Open a suite's Flight at Parallel setup. */
  openPortifyStage?: (feature: string) => void
  /** Open the changed-tests review, on `focus` when named. */
  openReview?: (focus?: ReviewFocus) => void
}

const EMPTY_ACTIONS: WorkspaceActions = Object.freeze({})

const WorkspaceActionsContext = createContext<WorkspaceActions>(EMPTY_ACTIONS)

/** Rebuilds its value only when one of the callbacks changes identity, so a
 *  consumer that keeps an action in a dependency list re-runs exactly when it
 *  would have with the same callback passed as a prop. */
export function WorkspaceActionsProvider({
  openFlight, openActivity, startFlight, openPreFlight, navigateToRun, openPortifyStage, openReview, children,
}: WorkspaceActions & { children: ReactNode }) {
  const value = useMemo<WorkspaceActions>(
    () => ({ openFlight, openActivity, startFlight, openPreFlight, navigateToRun, openPortifyStage, openReview }),
    [openFlight, openActivity, startFlight, openPreFlight, navigateToRun, openPortifyStage, openReview],
  )
  return <WorkspaceActionsContext.Provider value={value}>{children}</WorkspaceActionsContext.Provider>
}

/** The workspace actions, or a frozen empty object when no provider is above. */
export function useWorkspaceActions(): WorkspaceActions {
  return useContext(WorkspaceActionsContext)
}
