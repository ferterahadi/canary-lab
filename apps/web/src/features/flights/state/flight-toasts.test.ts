import { describe, expect, it } from 'vitest'
import {
  AGGREGATE_TOAST_ID,
  attentionKey,
  flightNeedsAttention,
  type FlightAttentionInput,
} from './flight-toasts'
import type { FlightPauseReason, FlightStatus } from '../../../shared/api/client'

const fl = (over: Partial<FlightAttentionInput> = {}): FlightAttentionInput => ({
  flightId: 'fl_1',
  feature: 'checkout',
  status: 'running',
  ...over,
})

describe('flightNeedsAttention (R68 attention predicate)', () => {
  it('waiting-for-approval always needs attention', () => {
    expect(flightNeedsAttention({ status: 'waiting-for-approval' })).toBe(true)
  })

  it('a stage-failed / restart pause needs attention', () => {
    expect(flightNeedsAttention({ status: 'paused', pauseReason: 'stage-failed' })).toBe(true)
    expect(flightNeedsAttention({ status: 'paused', pauseReason: 'restart' })).toBe(true)
  })

  it('a user pause does NOT need attention', () => {
    expect(flightNeedsAttention({ status: 'paused', pauseReason: 'user' })).toBe(false)
  })

  it('a queued pause NEVER needs attention', () => {
    expect(flightNeedsAttention({ status: 'paused', pauseReason: 'queued' })).toBe(false)
  })

  it('active / terminal statuses do not need attention', () => {
    for (const status of ['running', 'passed', 'failed', 'aborted'] as FlightStatus[]) {
      expect(flightNeedsAttention({ status })).toBe(false)
    }
  })
})

describe('attentionKey (diff key folds pauseReason in)', () => {
  it('distinguishes a user pause from a stage-failed pause on the same status', () => {
    expect(attentionKey({ status: 'paused', pauseReason: 'user' }))
      .not.toBe(attentionKey({ status: 'paused', pauseReason: 'stage-failed' }))
  })

  it('is stable for the same status+reason', () => {
    expect(attentionKey({ status: 'waiting-for-approval' }))
      .toBe(attentionKey({ status: 'waiting-for-approval' }))
  })
})

// ---------------------------------------------------------------------------
// The App effect's decision flow, replicated over the real helpers. This mirrors
// exactly the per-flight branch in App.tsx (seed → aggregate; post-seed → sticky
// per-flight, suppressing the on-screen flight, excluding queued). Verifying it
// here keeps the rules honest without mounting the whole App/WS/RunsContext.
// ---------------------------------------------------------------------------

interface ToastLike { id: string; sticky?: boolean }

function runDiff(
  prev: Map<string, string> | null,
  flights: FlightAttentionInput[],
  ctx: { view: string; selectedFlightId: string | null },
): { toasts: ToastLike[]; nextKeys: Map<string, string> } {
  const toasts: ToastLike[] = []
  const nextKeys = new Map(flights.map((f) => [f.flightId, attentionKey(f)]))
  if (prev === null) {
    const waiting = flights.filter(flightNeedsAttention)
    if (waiting.length > 0) toasts.push({ id: AGGREGATE_TOAST_ID, sticky: true })
    return { toasts, nextKeys }
  }
  for (const f of flights) {
    if (prev.get(f.flightId) === attentionKey(f)) continue
    if (!flightNeedsAttention(f)) continue
    if (ctx.view === 'flights' && ctx.selectedFlightId === f.flightId) continue
    toasts.push({ id: f.flightId, sticky: true })
  }
  return { toasts, nextKeys }
}

const noView = { view: 'workspace', selectedFlightId: null }

describe('flight-toast diff flow (R68)', () => {
  it('seed: N already-waiting flights collapse into ONE aggregate sticky toast', () => {
    const flights = [
      fl({ flightId: 'a', status: 'waiting-for-approval' }),
      fl({ flightId: 'b', status: 'paused', pauseReason: 'stage-failed' }),
      fl({ flightId: 'c', status: 'running' }),
    ]
    const { toasts } = runDiff(null, flights, noView)
    expect(toasts).toHaveLength(1)
    expect(toasts[0]).toEqual({ id: AGGREGATE_TOAST_ID, sticky: true })
  })

  it('seed: no aggregate toast when nothing needs attention', () => {
    const flights = [fl({ flightId: 'a', status: 'running' })]
    expect(runDiff(null, flights, noView).toasts).toHaveLength(0)
  })

  it('first sight after seed: a newly-revealed waiting flight fires its own sticky toast', () => {
    // Seed with a running flight; reconnect reveals it now waiting.
    const seed = runDiff(null, [fl({ flightId: 'a', status: 'running' })], noView)
    const after = runDiff(seed.nextKeys, [fl({ flightId: 'a', status: 'waiting-for-approval' })], noView)
    expect(after.toasts).toEqual([{ id: 'a', sticky: true }])
  })

  it('first sight after seed: a flight NEVER before seen, already waiting, still toasts', () => {
    const seed = runDiff(null, [], noView)
    const after = runDiff(seed.nextKeys, [fl({ flightId: 'new', status: 'waiting-for-approval' })], noView)
    expect(after.toasts).toEqual([{ id: 'new', sticky: true }])
  })

  it('a user→stage-failed pause transition toasts (pauseReason folded into the key)', () => {
    const seed = runDiff(null, [fl({ flightId: 'a', status: 'paused', pauseReason: 'user' })], noView)
    // Seed was a user pause → no aggregate.
    expect(seed.toasts).toHaveLength(0)
    const after = runDiff(seed.nextKeys, [fl({ flightId: 'a', status: 'paused', pauseReason: 'stage-failed' })], noView)
    expect(after.toasts).toEqual([{ id: 'a', sticky: true }])
  })

  it('queued flights never toast — seed and transition alike', () => {
    const queued = (id: string): FlightAttentionInput =>
      fl({ flightId: id, status: 'paused', pauseReason: 'queued' as FlightPauseReason })
    expect(runDiff(null, [queued('a')], noView).toasts).toHaveLength(0)
    const seed = runDiff(null, [fl({ flightId: 'a', status: 'running' })], noView)
    expect(runDiff(seed.nextKeys, [queued('a')], noView).toasts).toHaveLength(0)
  })

  it('suppression: the on-screen flight is not toasted, but a sibling still is', () => {
    const seed = runDiff(null, [
      fl({ flightId: 'a', status: 'running' }),
      fl({ flightId: 'b', status: 'running' }),
    ], noView)
    const after = runDiff(seed.nextKeys, [
      fl({ flightId: 'a', status: 'waiting-for-approval' }),
      fl({ flightId: 'b', status: 'waiting-for-approval' }),
    ], { view: 'flights', selectedFlightId: 'a' })
    // 'a' is on screen → suppressed; 'b' still toasts.
    expect(after.toasts).toEqual([{ id: 'b', sticky: true }])
  })

  it('no re-toast when the attention key is unchanged across refreshes', () => {
    const seed = runDiff(null, [fl({ flightId: 'a', status: 'running' })], noView)
    const first = runDiff(seed.nextKeys, [fl({ flightId: 'a', status: 'waiting-for-approval' })], noView)
    expect(first.toasts).toHaveLength(1)
    const second = runDiff(first.nextKeys, [fl({ flightId: 'a', status: 'waiting-for-approval' })], noView)
    expect(second.toasts).toHaveLength(0)
  })
})
