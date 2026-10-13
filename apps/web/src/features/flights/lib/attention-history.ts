import { hasFlightAttention, type FlightAttention } from '@shared/flights/attention'
import type { FlightManifest, FlightStageKey } from '@shared/flights/types'
import { systemLogId } from '@/shared/ui/activity-log'

/** A retained assessment is not confirmed current while its read path fails. */
export function withUnverifiedAttention<T extends { attention?: FlightAttention }>(record: T, reason: string): T {
  if (!hasFlightAttention(record.attention)) return record
  return { ...record, attention: { ...record.attention, state: 'unavailable', title: 'Could not verify current state', reason } }
}

/** Whether the flight's assessment points at this stage or its folded companion. */
export function flightAttentionOnStage(flight: FlightManifest, key: FlightStageKey, companionKey?: FlightStageKey): boolean {
  return hasFlightAttention(flight.attention)
    && (flight.attention.stage === key || flight.attention.stage === companionKey)
}

/** The execution journal supplies history even when a later job supplies the
 * displayed stage status. This is a system record, not an agent transcript. */
export function attentionFailureHistory(flight: FlightManifest, key: FlightStageKey, companionKey?: FlightStageKey) {
  if (flight.pauseReason !== 'stage-failed' || !flightAttentionOnStage(flight, key, companionKey)) return undefined
  const recorded = flight.stages.find((stage) => stage.key === flight.attention!.stage)
  const error = recorded?.error ?? flight.error
  if (!error) return undefined
  const at = recorded?.endedAt ?? flight.updatedAt
  const line = `[failure@${at}] Earlier failure\n${error}`
  return { line, id: systemLogId(line) }
}
