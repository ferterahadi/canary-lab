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
    const attention = !!run || (record?.status === 'dirty' && record.dirtySpecs.length > 0)
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
          ? `${pending} test file${pending === 1 ? '' : 's'} changed after this run started. ${weaker ? 'A check found a possible weakening. This hint does not change the run result. ' : ''}Review the test-file changes, then adopt or restore them.`
          : `${pending} test file${pending === 1 ? '' : 's'} changed. ${weaker ? 'A check found a possible weakening. This hint does not change the run result. ' : ''}Compare the test versions and review the changes.`,
        severity: weaker ? 'danger' as const : 'warning' as const,
        target: run
          ? { kind: 'test-review' as const, feature, runId: run.runId }
          : { kind: 'test-review' as const, feature },
      } } : {}),
    }
  })
}
import type { FeatureCoverageChange } from '../../../../../shared/coverage/freshness'

/** One persistent issue per suite, not one alert per save. A changed revision
 * updates its explanation; only recovery followed by new drift starts an episode. */
export function coverageNotificationSources(changes: FeatureCoverageChange[]): NotificationSource[] {
  return changes.map(({ feature, freshness, flightId }) => {
    const attention = ['stale', 'unavailable', 'updating'].includes(freshness.state)
    return {
      key: `coverage:${feature}`,
      signature: attention ? 'attention' : 'quiet',
      ...(attention ? { message: {
        title: `${feature}: ${freshness.state === 'updating' ? 'coverage update in progress' : freshness.state === 'unavailable' ? 'coverage freshness unavailable' : 'coverage out of date'}`,
        body: [...freshness.reasons, 'Previous coverage figures are historical until current inputs are checked. Open Flight to resume the affected stage.'].join(' '),
        severity: 'warning' as const,
        target: { kind: 'coverage' as const, feature, stage: freshness.nextAction?.stage ?? 'specs-coverage', ...(flightId ? { flightId } : {}) },
      } } : {}),
    }
  })
}

/** Execution evidence is not mapping freshness or test review. Keep its own
 * identity so a failed run cannot rename an outdated-coverage notification. */
export function verificationNotificationSources(changes: FeatureCoverageChange[]): NotificationSource[] {
  return changes.map(({ feature, freshness, flightId }) => {
    const attention = freshness.latestRunFailed || (freshness.state === 'current' && freshness.proofNeedsRun)
    return {
      key: `verification:${feature}`,
      signature: attention ? 'attention' : 'quiet',
      ...(attention ? { message: {
        title: `${feature}: ${freshness.latestRunFailed ? 'latest run has failures' : 'current tests need verification'}`,
        body: freshness.latestRunFailed ? 'Review the latest run results. Updating coverage mappings does not resolve a failed test.'
          : 'Coverage mapping is not proof of a passing run. Open the Test run step to verify the current tests.',
        severity: freshness.latestRunFailed ? 'danger' as const : 'warning' as const,
        target: freshness.latestRunFailed && freshness.latestRunId
          ? { kind: 'run' as const, feature, runId: freshness.latestRunId }
          : { kind: 'coverage' as const, feature, stage: 'run' as const, ...(flightId ? { flightId } : {}) },
      } } : {}),
    }
  })
}
