import type { FlightCheckpointKind, FlightPauseReason, FlightStageKey, FlightStatus } from './types'

/** Read-time assessment; it never rewrites the execution journal. */
export interface FlightAttention {
  state: 'actionable' | 'resolved' | 'unavailable' | 'none'
  stage: FlightStageKey | null
  title: string
  reason: string
  checkedAt: string
  revision: string
  remainingStage?: FlightStageKey
}

export const FLIGHT_ATTENTION_RECONCILE_MS = 5_000

/** An assessment with something to show — anything but `none`. */
export function hasFlightAttention(attention: FlightAttention | undefined): attention is FlightAttention {
  return attention !== undefined && attention.state !== 'none'
}

/** Shared by the attention UI and the durable inbox producer. External-agent
 * handoffs and user/queue pauses do not ask the person in Canary to act. */
export function flightNeedsAttention(f: {
  status: FlightStatus
  pauseReason?: FlightPauseReason
  checkpointKind?: FlightCheckpointKind
  stageProducer?: 'internal' | 'external'
  attention?: FlightAttention
}): boolean {
  if (f.attention) return f.attention.state === 'actionable' || f.attention.state === 'unavailable'
  if (f.stageProducer === 'external') return false
  if (f.status === 'waiting-for-approval') return f.checkpointKind !== 'external-work'
  return f.status === 'paused' && f.pauseReason !== 'user' && f.pauseReason !== 'queued'
}
