import { describe, expect, it } from 'vitest'
import {
  AGGREGATE_TOAST_ID,
  attentionKey,
  attentionKeyMap,
  diffFlightToasts,
  flightNeedsAttention,
  type FlightAttentionInput,
} from './flight-toasts'
import type { FlightPauseReason, FlightStatus } from '@/shared/api/client'

// Stage-label resolver stub — the real STAGE_LABEL map lives on the component
// side and is injected into the pure diff, so the test supplies its own.
const stageLabel = (s: FlightAttentionInput['currentStage'] | undefined): string | null =>
  s ? ({ scout: 'Scout', run: 'Run' } as Record<string, string>)[s] ?? s : null

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
// The App effect's decision, now exercised over the REAL pure diff so the rules
// stay honest without mounting the whole App/WS/RunsContext. `attentionKeyMap`
// produces the `prev` a caller stores between refreshes.
// ---------------------------------------------------------------------------

const noView = { view: 'workspace', selectedFlightId: null }
const ids = (out: ReturnType<typeof diffFlightToasts>) => out.map((t) => t.id)

describe('diffFlightToasts (R68)', () => {
  it('seed: N already-waiting flights collapse into ONE aggregate sticky toast', () => {
    const flights = [
      fl({ flightId: 'a', status: 'waiting-for-approval' }),
      fl({ flightId: 'b', status: 'paused', pauseReason: 'stage-failed' }),
      fl({ flightId: 'c', status: 'running' }),
    ]
    const out = diffFlightToasts(null, flights, noView, stageLabel)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ id: AGGREGATE_TOAST_ID, kind: 'aggregate' })
    expect(out[0].title).toBe('2 flights need your input')
  })

  it('seed: no aggregate toast when nothing needs attention', () => {
    expect(diffFlightToasts(null, [fl({ flightId: 'a', status: 'running' })], noView, stageLabel)).toHaveLength(0)
  })

  it('seed: singular copy for exactly one waiting flight', () => {
    const out = diffFlightToasts(null, [fl({ status: 'waiting-for-approval' })], noView, stageLabel)
    // Copy preserved verbatim from the App effect ("need", not "needs").
    expect(out[0].title).toBe('1 flight need your input')
  })

  it('first sight after seed: a newly-revealed waiting flight fires its own sticky toast', () => {
    const prev = attentionKeyMap([fl({ flightId: 'a', status: 'running' })])
    const out = diffFlightToasts(prev, [fl({ flightId: 'a', status: 'waiting-for-approval', currentStage: 'scout' })], noView, stageLabel)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ id: 'a', kind: 'flight', title: 'checkout needs input' })
    expect(out[0].kind === 'flight' && out[0].body).toBe('Scout is waiting for you')
  })

  it('first sight after seed: a flight NEVER before seen, already waiting, still toasts', () => {
    const out = diffFlightToasts(attentionKeyMap([]), [fl({ flightId: 'new', status: 'waiting-for-approval' })], noView, stageLabel)
    expect(ids(out)).toEqual(['new'])
  })

  it('paused copy names the failed stage and points at resume', () => {
    const prev = attentionKeyMap([fl({ flightId: 'a', status: 'running' })])
    const out = diffFlightToasts(prev, [fl({ flightId: 'a', status: 'paused', pauseReason: 'stage-failed', currentStage: 'run' })], noView, stageLabel)
    expect(out[0]).toMatchObject({ title: 'checkout paused' })
    expect(out[0].kind === 'flight' && out[0].body).toBe('Run failed — open to resume')
  })

  it('a restart pause reads as interrupted, not failed', () => {
    const prev = attentionKeyMap([fl({ flightId: 'a', status: 'running' })])
    const out = diffFlightToasts(prev, [fl({ flightId: 'a', status: 'paused', pauseReason: 'restart', currentStage: 'specs-coverage' })], noView, stageLabel)
    expect(out[0]).toMatchObject({ title: 'checkout paused' })
    const body = out[0].kind === 'flight' ? out[0].body : ''
    expect(body).not.toMatch(/failed/)
    expect(body).toMatch(/interrupted by a server restart/i)
    expect(body).toMatch(/open to resume/)
  })

  it('a user→stage-failed pause transition toasts (pauseReason folded into the key)', () => {
    const prev = attentionKeyMap([fl({ flightId: 'a', status: 'paused', pauseReason: 'user' })])
    const out = diffFlightToasts(prev, [fl({ flightId: 'a', status: 'paused', pauseReason: 'stage-failed' })], noView, stageLabel)
    expect(ids(out)).toEqual(['a'])
  })

  it('queued flights never toast — seed and transition alike', () => {
    const queued = (id: string): FlightAttentionInput =>
      fl({ flightId: id, status: 'paused', pauseReason: 'queued' as FlightPauseReason })
    expect(diffFlightToasts(null, [queued('a')], noView, stageLabel)).toHaveLength(0)
    const prev = attentionKeyMap([fl({ flightId: 'a', status: 'running' })])
    expect(diffFlightToasts(prev, [queued('a')], noView, stageLabel)).toHaveLength(0)
  })

  it('suppression: the on-screen flight is not toasted, but a sibling still is', () => {
    const prev = attentionKeyMap([
      fl({ flightId: 'a', status: 'running' }),
      fl({ flightId: 'b', status: 'running' }),
    ])
    const out = diffFlightToasts(prev, [
      fl({ flightId: 'a', status: 'waiting-for-approval' }),
      fl({ flightId: 'b', status: 'waiting-for-approval' }),
    ], { view: 'flights', selectedFlightId: 'a' }, stageLabel)
    expect(ids(out)).toEqual(['b'])
  })

  it('no re-toast when the attention key is unchanged across refreshes', () => {
    const prev = attentionKeyMap([fl({ flightId: 'a', status: 'running' })])
    const waiting = [fl({ flightId: 'a', status: 'waiting-for-approval' })]
    const first = diffFlightToasts(prev, waiting, noView, stageLabel)
    expect(first).toHaveLength(1)
    const second = diffFlightToasts(attentionKeyMap(waiting), waiting, noView, stageLabel)
    expect(second).toHaveLength(0)
  })
})
