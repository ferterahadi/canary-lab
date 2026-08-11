import { describe, expect, it } from 'vitest'
import type { DraftRecord, RunIndexEntry } from '@/shared/api/types'
import type { PortifyIndexEntry } from '@/shared/api/client'
import { deriveFeatureActivity } from './feature-activity'

const run = (over: Partial<RunIndexEntry>): RunIndexEntry => ({
  runId: 'r1',
  feature: 'checkout',
  startedAt: '2026-01-01T00:00:00Z',
  status: 'running',
  ...over,
})

const portify = (over: Partial<PortifyIndexEntry>): PortifyIndexEntry => ({
  workflowId: 'wf1',
  feature: 'checkout',
  status: 'editing',
  startedAt: '2026-01-01T00:00:00Z',
  ...over,
})

const draft = (over: Partial<DraftRecord>): DraftRecord => ({
  draftId: 'd1',
  prdText: 'spec the checkout',
  prdDocuments: [],
  repos: [],
  featureName: 'checkout',
  status: 'generating',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  ...over,
})

describe('deriveFeatureActivity', () => {
  it('an EXTERNAL draft silent for over an hour stops counting as live authoring; fresh + server-spawned stay', () => {
    const nowMs = Date.parse('2026-01-02T00:00:00Z')
    const map = deriveFeatureActivity({
      activeRuns: [],
      portifyWorkflows: [],
      drafts: [
        draft({ featureName: 'stale', draftId: 'd-stale', producer: 'external', updatedAt: '2026-01-01T00:00:00Z' }),
        draft({ featureName: 'fresh', draftId: 'd-fresh', producer: 'external', updatedAt: '2026-01-01T23:30:00Z' }),
        // Server-spawned drafts have no TTL — boot reconcile owns their death.
        draft({ featureName: 'server', draftId: 'd-srv', updatedAt: '2026-01-01T00:00:00Z' }),
      ],
      nowMs,
    })
    expect(map.get('stale')).toBeUndefined()
    expect(map.get('fresh')).toEqual({ kind: 'authoring', draftId: 'd-fresh' })
    expect(map.get('server')).toEqual({ kind: 'authoring', draftId: 'd-srv' })
  })

  it('maps each absorbed surface to its verb with a handle into the real surface', () => {
    const map = deriveFeatureActivity({
      activeRuns: [run({ feature: 'a', runId: 'r-a' })],
      portifyWorkflows: [portify({ feature: 'b', workflowId: 'wf-b' })],
      drafts: [draft({ featureName: 'c', draftId: 'd-c' })],
    })
    expect(map.get('a')).toEqual({ kind: 'running', runId: 'r-a' })
    expect(map.get('b')).toEqual({ kind: 'portifying', workflowId: 'wf-b' })
    expect(map.get('c')).toEqual({ kind: 'authoring', draftId: 'd-c' })
  })

  it('splits the two run verbs on the run STATUS — a healing run is not "running"', () => {
    const map = deriveFeatureActivity({
      activeRuns: [
        run({ feature: 'repairing', runId: 'r-heal', status: 'healing' }),
        run({ feature: 'testing', runId: 'r-run', status: 'running' }),
      ],
      portifyWorkflows: [],
      drafts: [],
    })
    // The chip fed by this map is the only place a heal shows outside the run
    // detail header, so the status has to survive the collapse to one verb.
    expect(map.get('repairing')).toEqual({ kind: 'healing', runId: 'r-heal' })
    expect(map.get('testing')).toEqual({ kind: 'running', runId: 'r-run' })
  })

  it('marks a feature with a running evaluation export as exporting', () => {
    const map = deriveFeatureActivity({
      activeRuns: [],
      portifyWorkflows: [],
      drafts: [],
      exportTasks: [
        { taskId: 't-a', runId: 'r-a', feature: ' checkout ', status: 'running' },
        // A settled export is not activity — the pill would otherwise never
        // stop spinning after the first successful export.
        { taskId: 't-b', runId: 'r-b', feature: 'billing', status: 'completed' },
        // No feature to pin it to.
        { taskId: 't-c', runId: 'r-c', feature: '   ', status: 'running' },
      ] as never,
    })
    expect(map.get('checkout')).toEqual({ kind: 'exporting', taskId: 't-a', runId: 'r-a' })
    expect(map.get('billing')).toBeUndefined()
    expect(map.size).toBe(1)
  })

  it('a live run outranks an export on the same feature', () => {
    const map = deriveFeatureActivity({
      activeRuns: [run({ feature: 'checkout', runId: 'r-live' })],
      portifyWorkflows: [],
      drafts: [],
      exportTasks: [{ taskId: 't-a', runId: 'r-a', feature: 'checkout', status: 'running' }] as never,
    })
    expect(map.get('checkout')).toEqual({ kind: 'running', runId: 'r-live' })
  })

  it('one verb per feature, loudest wins: running > portifying > authoring', () => {
    const map = deriveFeatureActivity({
      activeRuns: [run({})],
      portifyWorkflows: [portify({})],
      drafts: [draft({})],
    })
    expect(map.get('checkout')?.kind).toBe('running')
    const noRun = deriveFeatureActivity({
      activeRuns: [],
      portifyWorkflows: [portify({})],
      drafts: [draft({})],
    })
    expect(noRun.get('checkout')?.kind).toBe('portifying')
  })

  it('ignores boots, benchmarks, terminal portify workflows, and resting drafts', () => {
    const map = deriveFeatureActivity({
      activeRuns: [
        run({ feature: 'boot-f', executionType: 'boot' }),
        run({ feature: 'bench-f', executionType: 'benchmark' }),
      ],
      portifyWorkflows: [portify({ feature: 'saved-f', status: 'saved' })],
      drafts: [draft({ featureName: 'ready-f', status: 'spec-ready' })],
    })
    expect(map.size).toBe(0)
  })

  it('skips an authoring draft that has no feature name yet (nothing to pin it to)', () => {
    const map = deriveFeatureActivity({
      activeRuns: [],
      portifyWorkflows: [],
      drafts: [draft({ featureName: undefined })],
    })
    expect(map.size).toBe(0)
  })
})
