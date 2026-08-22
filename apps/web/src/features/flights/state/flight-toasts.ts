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
 *      status === 'waiting-for-approval' — EXCEPT an `external-work` park, which
 *      is a hand-off to the user's own agent, i.e. work in progress, not a
 *      question; nothing there is answerable from this side  OR
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
import type { FlightCheckpointKind, FlightIndexEntry, FlightPauseReason, FlightStatus } from '@/shared/api/client'
import { isExternalWorkPark, isExternallyDriven } from '../lib/external-work'

export const AGGREGATE_TOAST_ID = 'flights-need-input'

/** A minimal shape of what the diff needs — lets tests build fixtures cheaply. */
export interface FlightAttentionInput {
  flightId: string
  feature: string
  status: FlightStatus
  pauseReason?: FlightPauseReason
  checkpointKind?: FlightCheckpointKind
  /** Who drives the flight (mirrored onto the index entry). An externally
   *  driven flight never nags: whatever it stopped on, the client that started
   *  it is the one that answers, and this reader has no control to press. */
  stageProducer?: 'internal' | 'external'
  currentStage?: FlightIndexEntry['currentStage']
}

/** True iff the flight is parked waiting on the USER (not queued, not a user
 *  pause) — i.e. it should nag. */
export function flightNeedsAttention(f: {
  status: FlightStatus
  pauseReason?: FlightPauseReason
  checkpointKind?: FlightCheckpointKind
  stageProducer?: 'internal' | 'external'
}): boolean {
  // Widened from the `external-work` park alone: a flight the user's own agent
  // is driving asks nothing of the person reading this UI whatever it stopped
  // on. The narrower check let a `prd-source` fork — or a stage-failed pause
  // the agent is about to resume — fire "X is waiting for you", which is the
  // toast that made a hand-off look like a demand and a failure look final.
  if (isExternallyDriven(f)) return false
  if (isExternalWorkPark(f)) return false
  if (f.status === 'waiting-for-approval') return true
  if (f.status === 'paused' && f.pauseReason !== 'user' && f.pauseReason !== 'queued') return true
  return false
}

/** The status key we diff on. Folding pauseReason in means a flight that moves
 *  from a user pause to a stage-failed pause (both `status:'paused'`) is still
 *  seen as a transition, so it can fire its toast.
 *
 *  checkpointKind folds in for the same reason, and it is load-bearing now that
 *  a hand-off is silent: a flight moving from an `external-work` park straight
 *  to a real question (both `waiting-for-approval`) would otherwise keep the
 *  same key, read as unchanged, and never toast the question. */
export function attentionKey(f: {
  status: FlightStatus
  pauseReason?: FlightPauseReason
  checkpointKind?: FlightCheckpointKind
}): string {
  const qualifier = f.pauseReason ?? f.checkpointKind
  return qualifier ? `${f.status}:${qualifier}` : f.status
}

/** The prev→next attention-key map used to diff one refresh against the last. */
export function attentionKeyMap(flights: FlightAttentionInput[]): Map<string, string> {
  return new Map(flights.map((f) => [f.flightId, attentionKey(f)]))
}

/** What the current screen is showing — an individual flight's toast is
 *  suppressed only while THAT flight's detail is on screen. */
export interface FlightToastContext {
  view: string
  selectedFlightId: string | null
}

/** A toast to raise, WITHOUT its onClick — the pure diff decides the copy and
 *  identity; the hook attaches navigation so this stays side-effect-free and
 *  unit-testable. `kind` tells the hook which navigation to wire. */
export type FlightToastDescriptor =
  | { id: string; kind: 'aggregate'; title: string; body: string }
  | { id: string; kind: 'flight'; flightId: string; title: string; body: string }

/**
 * The pure decision behind the attention-toast effect (R51/R68). Given the
 * previous attention-key map (null on the very first index load), the current
 * flights, and what's on screen, return the toasts to raise this pass. The
 * caller stores `attentionKeyMap(flights)` as the next `prev`.
 *
 * `stageLabelFor` resolves a stage key to its human label — injected so this
 * module stays free of the component-side STAGE_LABEL map.
 */
export function diffFlightToasts(
  prev: Map<string, string> | null,
  flights: FlightAttentionInput[],
  ctx: FlightToastContext,
  stageLabelFor: (stage: FlightIndexEntry['currentStage'] | undefined) => string | null,
): FlightToastDescriptor[] {
  // Seed pass: collapse every already-parked flight into ONE aggregate toast so
  // a fresh page never opens under a wall of per-flight notifications.
  if (prev === null) {
    const waiting = flights.filter(flightNeedsAttention)
    if (waiting.length === 0) return []
    return [{
      id: AGGREGATE_TOAST_ID,
      kind: 'aggregate',
      title: `${waiting.length} flight${waiting.length === 1 ? '' : 's'} need your input`,
      body: 'Open the flights view to respond',
    }]
  }

  const out: FlightToastDescriptor[] = []
  for (const f of flights) {
    // First seen (post-seed) already in an attention state, or transitioning
    // into one, both qualify. Skip an unchanged key (already toasted) and any
    // flight no longer needing input.
    if (prev.get(f.flightId) === attentionKey(f)) continue
    if (!flightNeedsAttention(f)) continue
    // Suppress only while THIS flight's detail is on screen.
    if (ctx.view === 'flights' && ctx.selectedFlightId === f.flightId) continue
    const stageLabel = stageLabelFor(f.currentStage)
    const isCheckpoint = f.status === 'waiting-for-approval'
    // Non-checkpoint attention pauses are only 'restart' or 'stage-failed' here
    // ('user'/'queued' are filtered out above). A restart interruption is not a
    // failure — say so, so the toast matches the header chip's own wording.
    const restarted = f.pauseReason === 'restart'
    out.push({
      id: f.flightId,
      kind: 'flight',
      flightId: f.flightId,
      title: isCheckpoint ? `${f.feature} needs input` : `${f.feature} paused`,
      body: isCheckpoint
        ? (stageLabel ? `${stageLabel} is waiting for you` : 'A checkpoint is waiting for you')
        : restarted
          ? (stageLabel ? `${stageLabel} was interrupted by a server restart — open to resume` : 'Interrupted by a server restart — open to resume')
          : (stageLabel ? `${stageLabel} failed — open to resume` : 'A stage failed — open to resume'),
    })
  }
  return out
}
