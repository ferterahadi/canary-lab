import type { FlightIndexEntry, FlightStageKey, FlightStageStatus } from '@/shared/api/client'
import { presentedIndexStages } from './external-work'

/** Only active document/coverage stages explain generation in the coverage ledger. */
export function coverageGeneratingFlight(
  flights: FlightIndexEntry[],
  selectedFeature: string | null,
): { flightId: string; stage: FlightStageKey; stageStatus: FlightStageStatus } | null {
  if (!selectedFeature) return null
  const flight = flights.find((entry) =>
    (entry.status === 'running' || entry.status === 'waiting-for-approval') && entry.feature === selectedFeature)
  const stage = flight?.currentStage
  if (!flight || !stage) return null
  if (stage !== 'docs' && stage !== 'prd-summary' && stage !== 'specs-coverage') return null
  // A hand-off to the user's agent is active work, not a question for the UI.
  const stageStatus = presentedIndexStages(flight).find((entry) => entry.key === stage)?.status ?? 'running'
  return { flightId: flight.flightId, stage, stageStatus }
}
