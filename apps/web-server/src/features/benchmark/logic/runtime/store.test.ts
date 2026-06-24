import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { BenchmarkRunStore, type BenchmarkStoreEvent } from './store'
import { benchmarksIndexPath } from './paths'
import { atomicWrite } from '../../../../../../../shared/lib/atomic-write'
import type { BenchmarkManifest } from './types'

let logsDir: string
beforeEach(() => {
  logsDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-bench-')))
})

function makeManifest(over: Partial<BenchmarkManifest> = {}): BenchmarkManifest {
  return {
    benchmarkId: 'b1',
    feature: 'example_todo_api',
    skill: 'broken-delete-contract',
    level: 'med',
    iterations: 2,
    agent: 'claude',
    status: 'sabotaging',
    startedAt: '2026-06-03T00:00:00.000Z',
    currentIteration: 0,
    arms: [],
    results: [],
    ...over,
  }
}

describe('BenchmarkRunStore', () => {
  it('save() persists the manifest + index; get()/list() read it back', () => {
    const store = new BenchmarkRunStore(logsDir)
    const m = makeManifest()
    store.save(m)
    expect(store.get('b1')).toEqual(m)
    expect(store.list().map((e) => e.benchmarkId)).toEqual(['b1'])
    expect(store.list()[0].status).toBe('sabotaging')
  })

  it('save() upserts the index entry in place (no duplicate rows)', () => {
    const store = new BenchmarkRunStore(logsDir)
    store.save(makeManifest({ status: 'running' }))
    store.save(makeManifest({ status: 'done', endedAt: '2026-06-03T01:00:00.000Z' }))
    expect(store.list()).toHaveLength(1)
    expect(store.list()[0].status).toBe('done')
    expect(store.list()[0].endedAt).toBe('2026-06-03T01:00:00.000Z')
  })

  it('get() returns null for an unknown benchmark', () => {
    expect(new BenchmarkRunStore(logsDir).get('nope')).toBeNull()
  })

  it('save() emits a changed event; offEvent stops delivery', () => {
    const store = new BenchmarkRunStore(logsDir)
    const events: BenchmarkStoreEvent[] = []
    const fn = (e: BenchmarkStoreEvent) => events.push(e)
    store.onEvent(fn)
    store.save(makeManifest({ status: 'running' }))
    expect(events).toEqual([{ kind: 'changed', benchmarkId: 'b1' }])
    store.offEvent(fn)
    store.save(makeManifest({ status: 'done' }))
    expect(events).toHaveLength(1)
  })

  it('reconcileInterrupted() flips non-terminal benchmarks to aborted, leaves terminal ones', () => {
    const store = new BenchmarkRunStore(logsDir)
    store.save(makeManifest({ benchmarkId: 'live', status: 'running' }))
    store.save(makeManifest({ benchmarkId: 'setup', status: 'sabotaging' }))
    store.save(makeManifest({ benchmarkId: 'finished', status: 'done', endedAt: '2026-06-03T01:00:00.000Z' }))

    const events: BenchmarkStoreEvent[] = []
    store.onEvent((e) => events.push(e))
    store.reconcileInterrupted(() => '2026-06-03T09:00:00.000Z')

    expect(store.get('live')?.status).toBe('aborted')
    expect(store.get('live')?.endedAt).toBe('2026-06-03T09:00:00.000Z')
    expect(store.get('live')?.error).toMatch(/restart/i)
    expect(store.get('setup')?.status).toBe('aborted')
    // terminal benchmark untouched (no event, no status change)
    expect(store.get('finished')?.status).toBe('done')
    expect(events.map((e) => e.benchmarkId).sort()).toEqual(['live', 'setup'])
  })

  it('reconcileInterrupted() skips index entries whose manifest is missing', () => {
    const store = new BenchmarkRunStore(logsDir)
    // An index entry left as 'running' but with no manifest on disk (a partially
    // written benchmark). reconcile must skip it, not crash.
    atomicWrite(
      benchmarksIndexPath(logsDir),
      JSON.stringify([{ id: 'orphan', createdAt: 't', benchmarkId: 'orphan', feature: 'f', level: 'med', status: 'running', startedAt: 't' }], null, 2),
    )
    const events: BenchmarkStoreEvent[] = []
    store.onEvent((e) => events.push(e))
    store.reconcileInterrupted(() => 'now')
    // No manifest → nothing to flip → no event emitted for it.
    expect(events).toEqual([])
    expect(store.get('orphan')).toBeNull()
  })

  it('remove() drops it from the index, deletes its dir, and emits removed', () => {
    const store = new BenchmarkRunStore(logsDir)
    store.save(makeManifest())
    const events: BenchmarkStoreEvent[] = []
    store.onEvent((e) => events.push(e))
    store.remove('b1')
    expect(store.list()).toEqual([])
    expect(store.get('b1')).toBeNull()
    expect(events).toContainEqual({ kind: 'removed', benchmarkId: 'b1' })
  })

  it('statusOf config callback extracts the manifest status field', () => {
    const store = new BenchmarkRunStore(logsDir)
    const statusOf = (store as any).store.config.statusOf as (m: BenchmarkManifest) => string
    expect(statusOf(makeManifest({ status: 'running' }))).toBe('running')
    expect(statusOf(makeManifest({ status: 'done', endedAt: 'e' }))).toBe('done')
  })
})
