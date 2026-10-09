import { createContext, useContext, useMemo, type ReactNode } from 'react'
import type { FlightStageKey } from '@shared/flights/types'
import type { ConfigTab, RunOpenTarget } from '@/shared/lib/workspace-view-state'
import type { FlightLauncherIntent } from '@/shared/state/nav-state'

/** Drill-through targets: each stage view is a LENS onto the real underlying
 *  surface — the actual run detail, coverage ledger, or supporting config —
 *  never a re-implementation of them (R6). Parallel readiness itself stays in
 *  Flight; its optional drill opens Ports only as supporting configuration. */
export interface FlightDrillThroughs {
  /** `target` says where in the run detail to land — a failing test (Playwright)
   *  or a named tab (the run's captured fixes go to Changes). */
  onOpenRun?: (feature: string, runId: string, target?: RunOpenTarget) => void
  onOpenCoverage?: (feature: string) => void
}

/** What the open flight's stages can hand off to. FlightPage provides these
 *  from its own props, so the flight-origin binding stays in App and the call
 *  arguments are the ones FlightPage's callers already receive. Each is
 *  optional: a stage renders the matching affordance only when it is present. */
export interface FlightActions extends FlightDrillThroughs {
  /** Opens FeatureConfigEditor — the Feature Setup panel's Advanced setup, and
   *  the Parallel-readiness drill-through (which aims at the Ports tab). */
  onOpenConfig?: (feature: string, tab?: ConfigTab) => void
  /** Opens the changed-tests review — the run hero's "verdict from run-start
   *  snapshot · N pending edits" link. Omitted, the hero states the fact
   *  without a link. */
  onOpenSpecReview?: (feature: string, runId: string) => void
  /** Opens the flight launcher for this feature — the "Start fresh" handoff
   *  (R75): full restart with editable intent + repos lives THERE, never in
   *  the re-run dialog. */
  onStartFlight?: (feature: string, intent?: FlightLauncherIntent, fromStage?: FlightStageKey | null) => void
}

const EMPTY_FLIGHT_ACTIONS: FlightActions = Object.freeze({})

const FlightActionsContext = createContext<FlightActions>(EMPTY_FLIGHT_ACTIONS)

/** Rebuilds its value only when one of the callbacks changes identity. */
export function FlightActionsProvider({
  onOpenRun, onOpenCoverage, onOpenConfig, onOpenSpecReview, onStartFlight, children,
}: FlightActions & { children: ReactNode }) {
  const value = useMemo<FlightActions>(
    () => ({ onOpenRun, onOpenCoverage, onOpenConfig, onOpenSpecReview, onStartFlight }),
    [onOpenRun, onOpenCoverage, onOpenConfig, onOpenSpecReview, onStartFlight],
  )
  return <FlightActionsContext.Provider value={value}>{children}</FlightActionsContext.Provider>
}

/** The open flight's actions, or a frozen empty object outside a FlightPage. */
export function useFlightActions(): FlightActions {
  return useContext(FlightActionsContext)
}
