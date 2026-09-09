import type { FlightIndexEntry } from '../../../../../shared/flights/types'
import { flightNeedsAttention } from '../../../../../shared/flights/attention'
import { flightStageLabel } from '../../../../../shared/flights/stage-labels'
import type { NotificationSource } from '../../../../../shared/notifications/types'
import { isActiveRunStatus } from '../../../../../shared/run-state'
import type { StrengthVerdict } from '../../../../../shared/verification-strength/types'

interface TestChangeRecord {
  featureId: string
  status: 'dirty' | 'clean'
  dirtySpecs: Array<{ strength?: { verdict: StrengthVerdict } }>
}

interface ReviewRun {
  runId: string
  feature: string
  status: string
  pendingSpecEdits?: number
}

function hasWeakerHint(record: TestChangeRecord | undefined): boolean {
  return record?.status === 'dirty' && record.dirtySpecs.some((spec) => spec.strength?.verdict === 'weaker')
}

function awaitsTestReview(run: ReviewRun): boolean {
  return isActiveRunStatus(run.status) && (run.pendingSpecEdits ?? 0) > 0
}

export function flightNotificationSources(flights: FlightIndexEntry[]): NotificationSource[] {
  return flights.map((flight) => {
    const attention = flightNeedsAttention(flight)
    const stage = flight.currentStage ? flightStageLabel(flight.currentStage) : 'Flight'
    return {
      key: `flight:${flight.flightId}`,
      signature: attention ? `${flight.status}:${flight.pauseReason ?? flight.checkpointKind ?? ''}:${flight.currentStage ?? ''}` : 'quiet',
      ...(attention ? { message: {
        title: `${flight.feature} ${flight.status === 'waiting-for-approval' ? 'needs input' : 'paused'}`,
        body: flight.status === 'waiting-for-approval' ? `${stage} is waiting for you.`
          : flight.pauseReason === 'restart' ? `${stage} was interrupted by a server restart.` : `${stage} failed. Open the flight to continue.`,
        target: { kind: 'flight' as const, flightId: flight.flightId },
        severity: 'warning' as const,
      } } : {}),
    }
  })
}

export function runNotificationSources(runs: ReviewRun[], changes: TestChangeRecord[] = []): NotificationSource[] {
  const byFeature = new Map(changes.map((record) => [record.featureId, record]))
  return runs.map((run) => {
    const pending = run.pendingSpecEdits ?? 0
    const attention = awaitsTestReview(run)
    const weaker = hasWeakerHint(byFeature.get(run.feature))
    return {
      key: `run:${run.runId}`,
      signature: attention ? weaker ? 'test-review:weaker' : 'test-review' : 'quiet',
      ...(attention ? { message: {
        title: weaker ? `${run.feature}: tests may have been weakened` : `${run.feature} is awaiting test review`,
        body: `${pending} test file${pending === 1 ? '' : 's'} changed after this run started. ${weaker ? 'The checker found possible weakening — a hint, not a verdict. ' : ''}Review the changes, then adopt or restore them.`,
        severity: weaker ? 'danger' as const : 'warning' as const,
        target: { kind: 'test-review' as const, feature: run.feature, runId: run.runId },
      } } : {}),
    }
  })
}

/** Feature edits also exist without a running test. A pending run owns its
 * review alert while active, avoiding a second message for the same files. */
export function testChangeNotificationSources(changes: TestChangeRecord[], runs: ReviewRun[]): NotificationSource[] {
  const pendingFeatures = new Set(runs.filter(awaitsTestReview).map((run) => run.feature))
  return changes.map((record) => {
    const attention = record.status === 'dirty' && !pendingFeatures.has(record.featureId)
    const weaker = hasWeakerHint(record)
    const count = record.dirtySpecs.length
    return {
      key: `tests:${record.featureId}`,
      signature: attention ? weaker ? 'weaker' : 'changed' : 'quiet',
      ...(attention ? { message: {
        title: `${record.featureId}: ${weaker ? 'tests may have been weakened' : 'tests changed'}`,
        body: `${count} test file${count === 1 ? '' : 's'} changed. ${weaker ? 'The checker found possible weakening — a hint, not a verdict. ' : ''}Review the changes before relying on the previous result.`,
        severity: weaker ? 'danger' as const : 'neutral' as const,
        target: { kind: 'test-review' as const, feature: record.featureId },
      } } : {}),
    }
  })
}
