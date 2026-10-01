import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { BenchmarkRunStore } from '../../../../../web-server/src/features/benchmark/logic/runtime/store'
import type { BenchmarkManifest } from '../../../../../web-server/src/features/benchmark/logic/runtime/types'
import type { BenchmarkStatus } from '@shared/benchmark-index'
import { benchmarkIndex } from './benchmark-state'

const { reducer: benchmarkReducer, initialState: initialBenchmarkState } = benchmarkIndex

let logs: string
beforeEach(() => { logs = fs.mkdtempSync(path.join(os.tmpdir(), 'benchmark-index-parity-')) })
afterEach(() => { fs.rmSync(logs, { recursive: true, force: true }) })
function manifest(overrides: Partial<BenchmarkManifest> = {}): BenchmarkManifest {
  return {
    benchmarkId: 'benchmark-1', feature: 'checkout', level: 'med', skill: 'synthetic',
    iterations: 1, agent: 'claude', status: 'running', startedAt: '2026-01-01T00:00:00.000Z',
    currentIteration: 1, arms: [], results: [], ...overrides,
  }
}
it.each<BenchmarkStatus>(['sabotaging', 'ready', 'running', 'done', 'invalid', 'aborted', 'error'])('projects %s identically from a physical store and browser updates', (status) => {
  const store = new BenchmarkRunStore(logs)
  const initial = manifest()
  store.save(initial)
  const browser = benchmarkReducer(initialBenchmarkState, { type: 'snapshot', benchmarks: store.list(), details: {} })
  const next = manifest({ status, endedAt: '2026-01-01T00:01:00.000Z' })
  store.save(next)
  const updated = benchmarkReducer(browser, { type: 'update', benchmarkId: next.benchmarkId, manifest: next })
  expect(updated.benchmarks).toEqual(new BenchmarkRunStore(logs).list())
  expect(updated.benchmarks[0]).toEqual({ benchmarkId: next.benchmarkId, feature: 'checkout', level: 'med', status, startedAt: next.startedAt, endedAt: next.endedAt })
})
it.each([undefined, ''])('preserves legacy endedAt omission for %s', (endedAt) => {
  const store = new BenchmarkRunStore(logs)
  const next = manifest({ endedAt })
  store.save(next)
  const updated = benchmarkReducer(initialBenchmarkState, { type: 'update', benchmarkId: next.benchmarkId, manifest: next })
  expect(updated.benchmarks).toEqual(store.list())
  expect(updated.benchmarks[0]).not.toHaveProperty('endedAt')
})
