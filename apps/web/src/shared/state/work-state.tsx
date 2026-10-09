import { createContext, useContext, useMemo, type ReactNode } from 'react'
import type { CoverageJobIndexEntry } from '@shared/coverage/types'
import type { FlightIndexEntry, FlightStageKey, FlightStageStatus, PlanFeaturesTask } from '@shared/flights/types'
import type { PortifyIndexEntry } from '@shared/portify-index'
import type { FeatureActivity, FeatureExternalHistory } from '@/features/flights/state/feature-activity'
import type { DerivedStage } from '@/features/flights/lib/derived-stages'

// The workspace's live work snapshot — what is running, what ran outside a
// recorded Flight, and the evidence-derived rails — for leaves that sit
// several components below App. WorkspaceProvider fills it from its single
// `useWorkspaceFlights` call: that hook's coverage-job effect must run once per
// workspace, so a leaf reads this context rather than calling the hook again.

/** One picker row per workspace suite (R49); `stages` is its evidence-derived
 *  rail for a suite without a flight record. */
export interface PickerFeature {
  name: string
  group?: string
  stages?: Array<{ key: FlightStageKey; status: FlightStageStatus }>
}

export interface WorkState {
  flights?: FlightIndexEntry[]
  /** Plan-features tasks in progress or awaiting review. */
  preFlights?: PlanFeaturesTask[]
  /** Per-feature live activity (runs, portify, authoring, coverage). */
  activity?: Map<string, FeatureActivity>
  /** External-work provenance by feature and stage; outlives the live task. */
  externalHistory?: FeatureExternalHistory
  coverageJobs?: CoverageJobIndexEntry[]
  portifyWorkflows?: PortifyIndexEntry[]
  /** Evidence-derived rails per feature (R81). */
  derivedStages?: Map<string, DerivedStage[]>
  pickerFeatures?: PickerFeature[]
}

const EMPTY_WORK_STATE: WorkState = Object.freeze({})

const WorkStateContext = createContext<WorkState>(EMPTY_WORK_STATE)

/** Memoised on the exact references it is given, so a consumer's own
 *  `useMemo` over a field recomputes exactly when it did with that field passed
 *  as a prop. */
export function WorkStateProvider({
  flights, preFlights, activity, externalHistory, coverageJobs, portifyWorkflows, derivedStages, pickerFeatures, children,
}: WorkState & { children: ReactNode }) {
  const value = useMemo<WorkState>(
    () => ({ flights, preFlights, activity, externalHistory, coverageJobs, portifyWorkflows, derivedStages, pickerFeatures }),
    [flights, preFlights, activity, externalHistory, coverageJobs, portifyWorkflows, derivedStages, pickerFeatures],
  )
  return <WorkStateContext.Provider value={value}>{children}</WorkStateContext.Provider>
}

/** The live work snapshot; every field is undefined when no provider is above,
 *  which a leaf treats exactly as an omitted prop. */
export function useWorkState(): WorkState {
  return useContext(WorkStateContext)
}
