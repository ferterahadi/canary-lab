import { useCallback, useEffect, useMemo, useRef } from 'react'
import type { FlightIndexEntry } from '@/shared/api/client'
import type { Feature } from '@/shared/api/types'
import { resolveFeatureFlightAction } from '../components/FlightChipState'
import { useDerivedFeatureStages } from '../lib/derived-stages'
import { derivePendingFeatures } from '../lib/pending-features'
import { coverageGeneratingFlight } from '../lib/workspace-flights'
import { useFeatureWorkState } from './feature-activity'

interface WorkspaceFlightsInput {
  features: Feature[]
  flights: FlightIndexEntry[]
  selectedFeature: string | null
  refreshFeatures: () => void
  invalidateCoverage: () => void
}

/** One workspace snapshot feeds the picker, suite shortcuts, and coverage ledger. */
export function useWorkspaceFlights({
  features, flights, selectedFeature, refreshFeatures, invalidateCoverage,
}: WorkspaceFlightsInput) {
  const { activity, externalHistory, coverageJobs, portifyWorkflows } = useFeatureWorkState()
  const derivedStages = useDerivedFeatureStages(features, externalHistory)
  const coverageJobVersion = coverageJobs.map((job) => `${job.jobId}:${job.status}`).join('|')
  const seenCoverageJobVersion = useRef(coverageJobVersion)
  useEffect(() => {
    if (seenCoverageJobVersion.current === coverageJobVersion) return
    seenCoverageJobVersion.current = coverageJobVersion
    // Polling can discover completion after a lost workspace event. Refresh
    // suite evidence and ledger readers too, without creating a refetch loop.
    refreshFeatures()
    invalidateCoverage()
  }, [coverageJobVersion, refreshFeatures, invalidateCoverage])

  // Suite shortcuts and picker rails use the same evidence, including progress
  // made outside a recorded Flight. Keep the callback stable between snapshots.
  const flightAction = useCallback(
    (feature: string) => resolveFeatureFlightAction(feature, flights, activity.get(feature), derivedStages.get(feature)),
    [flights, activity, derivedStages],
  )
  const featuresWithPending = useMemo(() => {
    const pending = derivePendingFeatures(flights, features)
    return pending.length ? [...features, ...pending] : features
  }, [features, flights])
  const pickerFeatures = useMemo(() => features.map((feature) => ({
    name: feature.name,
    group: feature.group,
    stages: derivedStages.get(feature.name),
  })), [features, derivedStages])
  const generatingFlight = useMemo(() => coverageGeneratingFlight(flights, selectedFeature), [flights, selectedFeature])

  return {
    activity, externalHistory, coverageJobs, portifyWorkflows, derivedStages,
    selectedFeatureActivity: selectedFeature ? activity.get(selectedFeature) : undefined,
    flightAction, featuresWithPending, pickerFeatures, coverageGeneratingFlight: generatingFlight,
  }
}
