import { useCallback, useEffect, useMemo, useRef, type MutableRefObject } from 'react'
import { useRun } from '@/features/runs'
import type { Feature, RunIndexEntry } from '../api/types'
import {
  initialFeatureSelection, latestFeatureRunId, reconcileRunSelection,
  refreshedFeatureSelection, workspaceRunsForFeature,
} from './workspace-selection'

export interface WorkspaceSelectionInput {
  allRuns: readonly RunIndexEntry[]
  selectedFeature: string | null
  selectedRunId: string | null
  setSelectedFeature: (feature: string | null) => void
  setSelectedRunId: (runId: string | null) => void
  selectedFeatureRef: Readonly<MutableRefObject<string | null>>
  selectedRunIdRef: Readonly<MutableRefObject<string | null>>
  pendingRunSelectionRef: MutableRefObject<string | null>
}

/** Coordinates workspace selection without owning URL state or fetching indexes. */
export function useWorkspaceSelection({
  allRuns, selectedFeature, selectedRunId, setSelectedFeature, setSelectedRunId,
  selectedFeatureRef, selectedRunIdRef, pendingRunSelectionRef,
}: WorkspaceSelectionInput) {
  const initialFeatureRef = useRef(selectedFeature)
  const allRunsRef = useRef(allRuns)
  // Refresh callbacks must stay stable: the data hook's workspace socket
  // subscribes through them, and reconnecting on each run frame loses events.
  useEffect(() => { allRunsRef.current = allRuns }, [allRuns])

  const featureRuns = useMemo(() => workspaceRunsForFeature(allRuns, selectedFeature), [allRuns, selectedFeature])
  const latestRunForFeature = featureRuns[0] ?? null
  const selectedRunForFeature = selectedRunId
    ? featureRuns.find((run) => run.runId === selectedRunId) ?? null : null
  const statusRunId = selectedRunForFeature?.runId ?? latestRunForFeature?.runId ?? null

  useEffect(() => {
    const next = reconcileRunSelection(selectedFeature, selectedRunId,
      pendingRunSelectionRef.current, selectedRunForFeature, latestRunForFeature?.runId ?? null)
    pendingRunSelectionRef.current = next.pendingRunId
    if (next.runId !== selectedRunId) setSelectedRunId(next.runId)
  }, [latestRunForFeature?.runId, selectedFeature, selectedRunForFeature, selectedRunId, pendingRunSelectionRef, setSelectedRunId])

  const statusRunDetail = useRun(statusRunId)
  const selectedRunEvidence = {
    manifest: statusRunDetail.detail?.manifest,
    summary: statusRunDetail.detail?.summary,
    status: statusRunDetail.detail?.manifest.status ?? selectedRunForFeature?.status ?? latestRunForFeature?.status,
  }

  const onInitialFeatures = useCallback((features: readonly Feature[]): void => {
    const feature = initialFeatureSelection(features, initialFeatureRef.current)
    if (feature !== null) setSelectedFeature(feature)
  }, [setSelectedFeature])

  const onFeaturesRefreshed = useCallback((features: readonly Feature[], preferredFeature?: string | null): void => {
    const next = refreshedFeatureSelection(features, allRunsRef.current,
      selectedFeatureRef.current, selectedRunIdRef.current, preferredFeature)
    if (!next) return
    pendingRunSelectionRef.current = null
    setSelectedFeature(next.feature)
    setSelectedRunId(next.runId)
  }, [selectedFeatureRef, selectedRunIdRef, pendingRunSelectionRef, setSelectedFeature, setSelectedRunId])

  const selectFeatureForReview = useCallback((feature: string): void => {
    setSelectedFeature(feature)
    setSelectedRunId(latestFeatureRunId(allRunsRef.current, feature))
  }, [setSelectedFeature, setSelectedRunId])

  const selectFeature = useCallback((feature: string): void => {
    pendingRunSelectionRef.current = null
    selectFeatureForReview(feature)
  }, [pendingRunSelectionRef, selectFeatureForReview])

  return {
    featureRuns, selectedRunForFeature, statusRunDetail, selectedRunEvidence,
    onInitialFeatures, onFeaturesRefreshed, selectFeature, selectFeatureForReview,
  }
}
