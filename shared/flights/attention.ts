import type { FlightCheckpointKind, FlightPauseReason, FlightStatus } from './types'

/** Shared by the attention UI and the durable inbox producer. External-agent
 * handoffs and user/queue pauses do not ask the person in Canary to act. */
export function flightNeedsAttention(f: {
  status: FlightStatus
  pauseReason?: FlightPauseReason
  checkpointKind?: FlightCheckpointKind
  stageProducer?: 'internal' | 'external'
}): boolean {
  if (f.stageProducer === 'external') return false
  if (f.status === 'waiting-for-approval') return f.checkpointKind !== 'external-work'
  return f.status === 'paused' && f.pauseReason !== 'user' && f.pauseReason !== 'queued'
}
