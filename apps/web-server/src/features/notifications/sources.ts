import type { FlightIndexEntry } from '../../../../../shared/flights/types'
import { flightNeedsAttention } from '../../../../../shared/flights/attention'
import { flightStageLabel } from '../../../../../shared/flights/stage-labels'
import type { NotificationSource } from '../../../../../shared/notifications/types'

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
      } } : {}),
    }
  })
}

export function runNotificationSources(runs: Array<{ runId: string; feature: string; status: string; pendingSpecEdits?: number }>): NotificationSource[] {
  return runs.map((run) => {
    const pending = run.pendingSpecEdits ?? 0
    const attention = run.status === 'healing' && pending > 0
    return {
      key: `run:${run.runId}`,
      signature: attention ? 'test-review' : 'quiet',
      ...(attention ? { message: {
        title: `${run.feature} is awaiting test review`,
        body: `${pending} test file${pending === 1 ? '' : 's'} changed after this run started. Review the changes, then adopt or restore them.`,
        target: { kind: 'test-review' as const, feature: run.feature, runId: run.runId },
      } } : {}),
    }
  })
}
