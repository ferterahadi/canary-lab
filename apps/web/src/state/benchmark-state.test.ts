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

  it('connection sets the connection state', () => {
    const s = benchmarkReducer(initialBenchmarkState, { type: 'connection', status: 'live' })
    expect(s.connection).toBe('live')
  })
})

describe('frameToAction', () => {
  it('maps known frames and ignores unknown ones', () => {
    expect(frameToAction({ type: 'removed', benchmarkId: 'b1' })).toEqual({
      type: 'removed',
      benchmarkId: 'b1',
    })
    // @ts-expect-error — forwards-compat unknown frame
    expect(frameToAction({ type: 'nope' })).toBeNull()
  })
})
