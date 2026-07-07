/**
 * Pure derivation for the flight "needs your input" toasts (R51 + R68).
 *
 * The App owns a diff effect that fires toasts as flights change state. The
 * decision of WHICH flights deserve a toast — and whether the current pass is
 * the first (seed) pass that should collapse into one aggregate toast — is
 * factored out here so it is unit-testable without mounting the whole App.
 *
 * The rules (R68):
 *  - A flight *needs attention* iff it is waiting on the user:
 *      status === 'waiting-for-approval'  OR
 *      status === 'paused' with a pauseReason that isn't the user's own pause
 *      and isn't a queue park.
 *  - Queued flights (pauseReason 'queued') NEVER toast — they are just waiting
 *    for capacity, not for the user.
 *  - On the FIRST index load (seed), if N flights already need attention, fire
 *    ONE aggregate sticky toast rather than a storm of per-flight ones.
 *  - After seed, a flight that transitions INTO an attention state (or is first
 *    seen already in one) fires its own sticky toast.
 *  - Attention toasts are sticky (no auto-dismiss). Informational transitions
 *    (e.g. a flight finishing) keep the existing 8s auto-dismiss.
 *  - An individual flight's toast is suppressed only while THAT flight's detail
 *    view is on screen; the aggregate + other flights' toasts still show.
 */
import type { FlightIndexEntry, FlightPauseReason, FlightStatus } from '../../../shared/api/client'

export const AGGREGATE_TOAST_ID = 'flights-need-input'

/** A minimal shape of what the diff needs — lets tests build fixtures cheaply. */
export interface FlightAttentionInput {
  flightId: string
  feature: string
  status: FlightStatus
  pauseReason?: FlightPauseReason
  currentStage?: FlightIndexEntry['currentStage']
}

/** True iff the flight is parked waiting on the USER (not queued, not a user
 *  pause) — i.e. it should nag. */
export function flightNeedsAttention(f: {
  status: FlightStatus
  pauseReason?: FlightPauseReason
}): boolean {
  if (f.status === 'waiting-for-approval') return true
  if (f.status === 'paused' && f.pauseReason !== 'user' && f.pauseReason !== 'queued') return true
  return false
}

/** The status key we diff on. Folding pauseReason in means a flight that moves
 *  from a user pause to a stage-failed pause (both `status:'paused'`) is still
 *  seen as a transition, so it can fire its toast. */
export function attentionKey(f: { status: FlightStatus; pauseReason?: FlightPauseReason }): string {
  return f.pauseReason ? `${f.status}:${f.pauseReason}` : f.status
}
