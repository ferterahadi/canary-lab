import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { RobustnessJobRunStore, bridgeRobustnessJobEvents, robustnessJobStore } from './store'
import type { WorkspaceEvent } from '../../../../shared/workspace-events'
import { ROBUSTNESS_ENVELOPE_FORMAT } from '../../../../../../../shared/robustness/types'
import type { RobustnessJobManifest } from '../../../../../../../shared/robustness/jobs'

// The store is the generic FileBackedTaskStore under a robustness-shaped
// wrapper; these tests pin the wrapper's own decisions — the index row, the
// per-suite single-flight lookup, the reconcile policy, and the event the
// bridge announces — not the generic store's persistence, which has its own.

let tmpDir: string
let store: RobustnessJobRunStore

const now = () => '2026-09-10T00:00:00Z'

function makeManifest(jobId: string, overrides: Partial<RobustnessJobManifest> = {}): RobustnessJobManifest {
  return {
    jobId,
    feature: 'storefront-journey',
    runId: 'run-1',
    envelope: { format: ROBUSTNESS_ENVELOPE_FORMAT, latency: { ms: 300 } },
    status: 'running',
    startedAt: now(),
    cells: { planned: 6, done: 0 },
    findings: [],
    skipped: [],
    log: '',
    ...overrides,
  }
}

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-robustness-store-')))
  store = new RobustnessJobRunStore(tmpDir)
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('RobustnessJobRunStore', () => {
  it('writes <logs>/robustness-jobs/<id>/job.json and an index row with the finding count, newest first', () => {
    store.save(makeManifest('rj1'))
    store.save(makeManifest('rj2', {
      startedAt: '2026-09-10T00:01:00Z',
      findings: [{ cell: { specFile: 'storefront.spec.ts', atom: 'latency' }, failedTests: ['J2'], runId: 'cell-1', requirements: ['req-cart-total'], status: 'found', envelope: { format: ROBUSTNESS_ENVELOPE_FORMAT, latency: { ms: 300 } } }],
    }))
    expect(fs.existsSync(path.join(tmpDir, 'robustness-jobs', 'rj1', 'job.json'))).toBe(true)
    expect(fs.existsSync(path.join(tmpDir, 'robustness-jobs', 'index.json'))).toBe(true)
    expect(store.list()).toEqual([
      { jobId: 'rj2', feature: 'storefront-journey', runId: 'run-1', status: 'running', startedAt: '2026-09-10T00:01:00Z', findings: 1 },
      { jobId: 'rj1', feature: 'storefront-journey', runId: 'run-1', status: 'running', startedAt: now(), findings: 0 },
    ])
    expect(store.get('rj1')?.envelope.latency).toEqual({ ms: 300 })
    expect(store.get('ghost')).toBeNull()
  })

  it('clears a stale endedAt on the index row when a record is re-saved as running', () => {
    store.save(makeManifest('rj1', { status: 'done', endedAt: '2026-09-10T00:05:00Z' }))
    store.save(makeManifest('rj1'))
    expect(store.list()[0]).not.toHaveProperty('endedAt')
  })

  it('activeFor finds only the running job of that suite — the single-flight key', () => {
    store.save(makeManifest('done', { status: 'done', endedAt: now() }))
    store.save(makeManifest('other', { feature: 'other-suite' }))
    expect(store.activeFor('storefront-journey')).toBeNull()
    store.save(makeManifest('live', { startedAt: '2026-09-10T00:02:00Z' }))
    expect(store.activeFor('storefront-journey')?.jobId).toBe('live')
    expect(store.forFeature('storefront-journey').map((e) => e.jobId)).toEqual(['live', 'done'])
  })

  it('reconcileInterrupted flips a running job to aborted with the restart reason and leaves settled jobs alone', () => {
    store.save(makeManifest('live'))
    store.save(makeManifest('failed', { status: 'failed', endedAt: '2026-09-10T00:03:00Z', error: 'boom' }))
    store.reconcileInterrupted(() => '2026-09-10T00:09:00Z')
    expect(store.get('live')).toMatchObject({ status: 'aborted', endedAt: '2026-09-10T00:09:00Z', error: 'Interrupted by server restart' })
    expect(store.get('failed')).toMatchObject({ status: 'failed', endedAt: '2026-09-10T00:03:00Z', error: 'boom' })
    expect(store.activeFor('storefront-journey')).toBeNull()
  })

  it('renameFeature re-homes the suite\'s records and reports how many moved', () => {
    store.save(makeManifest('a'))
    store.save(makeManifest('b', { feature: 'other-suite' }))
    expect(store.renameFeature('storefront-journey', 'shop')).toBe(1)
    expect(store.get('a')?.feature).toBe('shop')
    expect(store.forFeature('shop')).toHaveLength(1)
  })

  it('remove drops the record and emits removed; a throwing listener does not stop the others', () => {
    const seen: string[] = []
    const bad = () => { throw new Error('listener bug') }
    store.onEvent(bad)
    store.onEvent((e) => seen.push(`${e.kind}:${e.jobId}`))
    store.save(makeManifest('rj1'))
    store.remove('rj1')
    expect(seen).toEqual(['changed:rj1', 'removed:rj1'])
    expect(store.get('rj1')).toBeNull()
    store.offEvent(bad)
    store.save(makeManifest('rj2'))
    expect(seen).toEqual(['changed:rj1', 'removed:rj1', 'changed:rj2'])
  })

  it('robustnessJobStore hands back one wrapper per logs dir', () => {
    const a = robustnessJobStore(tmpDir)
    expect(robustnessJobStore(path.join(tmpDir, '.'))).toBe(a)
    expect(robustnessJobStore(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-robustness-other-')))).not.toBe(a)
  })
})

describe('bridgeRobustnessJobEvents', () => {
  it('announces the job\'s suite on every write and stays quiet for a removed job', () => {
    const events: WorkspaceEvent[] = []
    bridgeRobustnessJobEvents(store, { publish: (e) => events.push(e) })
    store.save(makeManifest('rj1'))
    store.save(makeManifest('rj1', { cells: { planned: 6, done: 1 } }))
    store.remove('rj1')
    expect(events).toEqual([
      { type: 'robustness-changed', feature: 'storefront-journey' },
      { type: 'robustness-changed', feature: 'storefront-journey' },
    ])
  })

  it('does nothing without a publisher', () => {
    bridgeRobustnessJobEvents(store, undefined)
    expect(() => store.save(makeManifest('rj1'))).not.toThrow()
  })
})
