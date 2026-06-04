import { describe, it, expect } from 'vitest'
import {
  benchmarkReducer,
  initialBenchmarkState,
  frameToAction,
} from './benchmark-state'
import type { BenchmarkManifest } from '../api/benchmark-types'

function m(over: Partial<BenchmarkManifest> = {}): BenchmarkManifest {
  return {
    benchmarkId: 'b1',
    feature: 'example_todo_api',
    skill: 'broken-delete-contract',
    level: 'med',
    iterations: 2,
    agent: 'claude',
    status: 'running',
    startedAt: '2026-06-03T00:00:00.000Z',
    currentIteration: 1,
    arms: [],
    results: [],
    ...over,
  }
}

describe('benchmarkReducer', () => {
  it('snapshot sets benchmarks + details', () => {
    const s = benchmarkReducer(initialBenchmarkState, {
      type: 'snapshot',
      benchmarks: [
        { benchmarkId: 'b1', feature: 'f', level: 'med', status: 'running', startedAt: 't' },
      ],
      details: { b1: m() },
    })
    expect(s.benchmarks).toHaveLength(1)
    expect(s.details.b1.feature).toBe('example_todo_api')
  })

  it('update upserts the detail and derives a newest-first index entry', () => {
    let s = benchmarkReducer(initialBenchmarkState, {
      type: 'update',
      benchmarkId: 'b1',
      manifest: m({ startedAt: '2026-06-03T00:00:00.000Z' }),
    })
    s = benchmarkReducer(s, {
      type: 'update',
      benchmarkId: 'b2',
      manifest: m({ benchmarkId: 'b2', startedAt: '2026-06-03T01:00:00.000Z' }),
    })
    expect(s.benchmarks.map((b) => b.benchmarkId)).toEqual(['b2', 'b1'])
    expect(s.details.b2.benchmarkId).toBe('b2')
    expect(s.benchmarks.find((b) => b.benchmarkId === 'b1')?.status).toBe('running')
  })

  it('removed drops the benchmark + its detail', () => {
    let s = benchmarkReducer(initialBenchmarkState, {
      type: 'update',
      benchmarkId: 'b1',
      manifest: m(),
    })
    s = benchmarkReducer(s, { type: 'removed', benchmarkId: 'b1' })
    expect(s.benchmarks).toHaveLength(0)
    expect(s.details.b1).toBeUndefined()
  })

  it('carries endedAt into the derived index entry and breaks startedAt ties deterministically', () => {
    let s = benchmarkReducer(initialBenchmarkState, {
      type: 'update',
      benchmarkId: 'done1',
      manifest: m({ benchmarkId: 'done1', status: 'done', startedAt: '2026-06-03T00:00:00.000Z', endedAt: '2026-06-03T00:05:00.000Z' }),
    })
    s = benchmarkReducer(s, {
      type: 'update',
      benchmarkId: 'done2',
      manifest: m({ benchmarkId: 'done2', status: 'done', startedAt: '2026-06-03T00:00:00.000Z', endedAt: '2026-06-03T00:06:00.000Z' }),
    })
    const done1 = s.benchmarks.find((b) => b.benchmarkId === 'done1')
    expect(done1?.endedAt).toBe('2026-06-03T00:05:00.000Z')
    // Equal startedAt → stable (tie returns 0); both entries are present.
    expect(s.benchmarks.map((b) => b.benchmarkId).sort()).toEqual(['done1', 'done2'])
  })

  it('orders an older update after an existing newer one (ascending compare branch)', () => {
    let s = benchmarkReducer(initialBenchmarkState, {
      type: 'update',
      benchmarkId: 'newer',
      manifest: m({ benchmarkId: 'newer', startedAt: '2026-06-03T02:00:00.000Z' }),
    })
    // The new entry is OLDER, so the sort compares (older, newer) → returns 1.
    s = benchmarkReducer(s, {
      type: 'update',
      benchmarkId: 'older',
      manifest: m({ benchmarkId: 'older', startedAt: '2026-06-03T01:00:00.000Z' }),
    })
    expect(s.benchmarks.map((b) => b.benchmarkId)).toEqual(['newer', 'older'])
  })

  it('connection sets the connection state', () => {
    const s = benchmarkReducer(initialBenchmarkState, { type: 'connection', status: 'live' })
    expect(s.connection).toBe('live')
  })
})

describe('frameToAction', () => {
  it('maps a snapshot frame to a snapshot action', () => {
    const benchmarks = [{ benchmarkId: 'b1', feature: 'f', level: 'med' as const, status: 'running' as const, startedAt: 't' }]
    const details = { b1: m() }
    expect(frameToAction({ type: 'snapshot', benchmarks, details })).toEqual({
      type: 'snapshot',
      benchmarks,
      details,
    })
  })

  it('maps an update frame to an update action', () => {
    const manifest = m()
    expect(frameToAction({ type: 'update', benchmarkId: 'b1', manifest })).toEqual({
      type: 'update',
      benchmarkId: 'b1',
      manifest,
    })
  })

  it('maps known frames and ignores unknown ones', () => {
    expect(frameToAction({ type: 'removed', benchmarkId: 'b1' })).toEqual({
      type: 'removed',
      benchmarkId: 'b1',
    })
    // @ts-expect-error — forwards-compat unknown frame
    expect(frameToAction({ type: 'nope' })).toBeNull()
  })
})
