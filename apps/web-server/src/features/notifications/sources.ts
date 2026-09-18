import type { FlightIndexEntry } from '../../../../../shared/flights/types'
import { flightNeedsAttention } from '../../../../../shared/flights/attention'
import { flightCheckpointTitle } from '../../../../../shared/flights/checkpoint-labels'
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
    const waiting = flight.status === 'waiting-for-approval'
    const title = waiting
      ? flight.checkpointKind ? flightCheckpointTitle(flight.checkpointKind) : `${stage} needs your input`
      : flight.pauseReason === 'restart' ? `${stage} was interrupted` : `${stage} failed`
    return {
      key: `flight:${flight.flightId}`,
      signature: attention ? `${flight.status}:${flight.pauseReason ?? flight.checkpointKind ?? ''}:${flight.currentStage ?? ''}` : 'quiet',
      ...(attention ? { message: {
        title: `${flight.feature}: ${title}`,
        body: waiting ? `${stage} cannot continue until you respond.`
          : flight.pauseReason === 'restart' ? 'The server restarted. Open Flight to resume.' : 'Open Flight to recover and continue.',
        target: { kind: 'flight' as const, flightId: flight.flightId },
        severity: 'warning' as const,
        toast: true,
      } } : {}),
    }
  })
}

/** One test-change topic per suite, independent of coverage freshness. A blocked
 * run supplies the review target; resolving coverage must never dismiss edits. */
export function testReviewNotificationSources(runs: ReviewRun[], changes: TestChangeRecord[] = []): NotificationSource[] {
  const changesByFeature = new Map(changes.map((record) => [record.featureId, record]))
  const pendingRunByFeature = new Map<string, ReviewRun>()
  for (const run of runs) {
    if (awaitsTestReview(run) && !pendingRunByFeature.has(run.feature)) pendingRunByFeature.set(run.feature, run)
  }
  const features = new Set([...changesByFeature.keys(), ...pendingRunByFeature.keys()])

  return [...features].map((feature) => {
    const record = changesByFeature.get(feature)
    const run = pendingRunByFeature.get(feature)
    const weaker = hasWeakerHint(record)
    const blocking = !!run
    const attention = blocking || weaker
    const pending = run?.pendingSpecEdits ?? record?.dirtySpecs.length ?? 0
    return {
      key: `test-review:${feature}`,
      // Message detail and severity may evolve, but the user still has one
      // unresolved issue. Keeping one active signature updates that issue in
      // place; quiet -> attention still creates a fresh episode later.
      signature: attention ? 'attention' : 'quiet',
      ...(attention ? { message: {
        title: weaker ? `${feature}: possible test weakening` : `${feature}: tests changed`,
        body: run
          ? `${pending} test file${pending === 1 ? '' : 's'} changed after this run started. ${weaker ? 'A check found a possible weakening. This hint does not change the run result. ' : ''}Review the changes to continue the run.`
          : `${pending} test file${pending === 1 ? '' : 's'} changed. ${weaker ? 'A check found a possible weakening. This hint does not change the run result. ' : ''}Compare the test versions and review the changes.`,
        severity: weaker ? 'danger' as const : 'warning' as const,
        toast: blocking,
        target: run
          ? { kind: 'test-review' as const, feature, runId: run.runId }
          : { kind: 'test-review' as const, feature },
      } } : {}),
    }
  })
}
