import { describe, expect, it } from 'vitest'
import type { CoverageJobIndexEntry, DraftRecord, EvaluationExportTask, RunIndexEntry } from '@/shared/api/types'
import type { PortifyIndexEntry } from '@/shared/api/client'
import { deriveFeatureActivity, deriveFeatureExternalHistory } from './feature-activity'

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
    expect(map.get('fresh')).toEqual({ kind: 'authoring', draftId: 'd-fresh', external: true })
    expect(map.get('server')).toEqual({ kind: 'authoring', draftId: 'd-srv', external: false })
  })

  it('maps each absorbed surface to its verb with a handle into the real surface', () => {
    const map = deriveFeatureActivity({
      activeRuns: [run({ feature: 'a', runId: 'r-a' })],
      portifyWorkflows: [portify({ feature: 'b', workflowId: 'wf-b' })],
      drafts: [draft({ featureName: 'c', draftId: 'd-c' })],
    })
    expect(map.get('a')).toEqual({ kind: 'running', runId: 'r-a', external: false })
    expect(map.get('b')).toEqual({ kind: 'portifying', workflowId: 'wf-b', external: false })
    expect(map.get('c')).toEqual({ kind: 'authoring', draftId: 'd-c', external: false })
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
    expect(map.get('repairing')).toEqual({ kind: 'healing', runId: 'r-heal', external: false })
    expect(map.get('testing')).toEqual({ kind: 'running', runId: 'r-run', external: false })
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
    expect(map.get('checkout')).toEqual({ kind: 'exporting', taskId: 't-a', runId: 'r-a', external: false })
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
    expect(map.get('checkout')).toEqual({ kind: 'running', runId: 'r-live', external: false })
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

  it('maps the two coverage job phases to their own verbs, later phase winning', () => {
    const job = (over: Partial<CoverageJobIndexEntry>): CoverageJobIndexEntry => ({
      jobId: 'j1', feature: 'checkout', kind: 'summary', status: 'running',
      startedAt: '2026-01-01T00:00:00Z', producer: 'external',
      ...over,
    } as CoverageJobIndexEntry)
    const map = deriveFeatureActivity({
      activeRuns: [],
      portifyWorkflows: [],
      drafts: [],
      coverageJobs: [
        job({ feature: 'distilling', jobId: 'j-sum' }),
        job({ feature: 'annotating', jobId: 'j-map', kind: 'coverage', producer: undefined }),
        // A settled job is not activity.
        job({ feature: 'done-f', jobId: 'j-done', status: 'done' }),
        // Both phases live on one feature → the chained mapping job wins (the
        // summary phase is already done by the time mapping starts).
        job({ feature: 'both', jobId: 'j-b-sum' }),
        job({ feature: 'both', jobId: 'j-b-map', kind: 'coverage' }),
      ],
    })
    expect(map.get('distilling')).toEqual({ kind: 'condensing', jobId: 'j-sum', external: true })
    expect(map.get('annotating')).toEqual({ kind: 'mapping', jobId: 'j-map', external: false })
    expect(map.get('done-f')).toBeUndefined()
    expect(map.get('both')).toEqual({ kind: 'mapping', jobId: 'j-b-map', external: true })
  })

  it('a verify-mode run reads as verifying, external when its manifest heals externally', () => {
    const map = deriveFeatureActivity({
      activeRuns: [
        run({ feature: 'staging', runId: 'r-ver', executionType: 'verify' }),
        run({ feature: 'ext', runId: 'r-ext', executionType: 'verify' }),
      ],
      portifyWorkflows: [],
      drafts: [],
      runDetails: { 'r-ext': { manifest: { healMode: 'external' } } } as never,
    })
    expect(map.get('staging')).toEqual({ kind: 'verifying', runId: 'r-ver', external: false })
    expect(map.get('ext')).toEqual({ kind: 'verifying', runId: 'r-ext', external: true })
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

describe('deriveFeatureExternalHistory', () => {
  it('keeps an accepted external authoring hand-off after live activity ends', () => {
    const history = deriveFeatureExternalHistory({
      runs: [],
      portifyWorkflows: [],
      draftRecords: [draft({
        status: 'accepted',
        producer: 'external',
        externalClientKind: 'claude',
        externalSessionId: 'session-1',
        externalConversationName: 'Coverage repair',
        externalSessionUrl: 'claude://session/1',
        generatedFiles: ['a.spec.ts', 'b.spec.ts'],
        updatedAt: '2026-01-01T00:05:00Z',
      })],
    })
    expect(history.get('checkout')?.['specs-coverage']?.current).toMatchObject({
      kind: 'authoring',
      resourceId: 'd1',
      status: 'done',
      clientKind: 'claude',
      sessionId: 'session-1',
      conversationName: 'Coverage repair',
      sessionUrl: 'claude://session/1',
      itemCount: 2,
    })
  })

  it('keeps stale external provenance as history without letting it own the stage', () => {
    const history = deriveFeatureExternalHistory({
      runs: [],
      portifyWorkflows: [],
      draftRecords: [
        draft({ producer: 'external', status: 'accepted', updatedAt: '2026-01-01T00:05:00Z' }),
        draft({ draftId: 'd2', producer: 'internal', status: 'accepted', updatedAt: '2026-01-01T00:06:00Z' }),
      ],
    })
    const stage = history.get('checkout')?.['specs-coverage']
    expect(stage?.current).toBeUndefined()
    expect(stage?.traces.map((trace) => trace.resourceId)).toEqual(['d1'])
  })

  it('keeps every external coverage pass in chronological order', () => {
    const history = deriveFeatureExternalHistory({
      runs: [],
      portifyWorkflows: [],
      draftRecords: [],
      coverageJobs: [
        {
          jobId: 'j-first', feature: 'checkout', kind: 'coverage', status: 'done', producer: 'external',
          startedAt: '2026-01-01T00:00:00Z', endedAt: '2026-01-01T00:04:00Z',
        },
        {
          jobId: 'j-second', feature: 'checkout', kind: 'coverage', status: 'done', producer: 'external',
          startedAt: '2026-01-01T00:05:00Z', endedAt: '2026-01-01T00:06:00Z',
        },
      ],
    })

    const stage = history.get('checkout')?.['specs-coverage']
    expect(stage?.traces.map((trace) => trace.resourceId)).toEqual(['j-first', 'j-second'])
    expect(stage?.current?.resourceId).toBe('j-second')
  })

  it('maps persistent coverage, portify, run and export producers to their Flight stages', () => {
    const history = deriveFeatureExternalHistory({
      runs: [run({ runId: 'r-ext', feature: 'run-suite', status: 'passed', healMode: 'external', endedAt: '2026-01-01T00:09:00Z' })],
      portifyWorkflows: [portify({ feature: 'ports', status: 'saved', producer: 'external', endedAt: '2026-01-01T00:07:00Z' })],
      draftRecords: [],
      coverageJobs: [{
        jobId: 'j1', feature: 'coverage', kind: 'coverage', status: 'done',
        producer: 'external', startedAt: '2026-01-01T00:00:00Z', endedAt: '2026-01-01T00:04:00Z',
      }],
      exportTasks: [{
        taskId: 't1', runId: 'r1', feature: 'report', mode: 'raw', producer: 'external',
        status: 'completed', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:08:00Z', downloadReady: true,
      }] as EvaluationExportTask[],
      portifyDetails: {
        wf1: {
          workflowId: 'wf1', feature: 'ports', producer: 'external', status: 'saved',
          startedAt: '2026-01-01T00:00:00Z', endedAt: '2026-01-01T00:07:00Z',
          external: { clientKind: 'codex', sessionId: 'port-session', sessionUrl: 'codex://session/port' },
        },
      } as never,
    })
    expect(history.get('coverage')?.['specs-coverage']?.current).toMatchObject({ status: 'done', resourceId: 'j1' })
    expect(history.get('ports')?.portify?.current).toMatchObject({
      status: 'done', resourceId: 'wf1', clientKind: 'codex', sessionId: 'port-session', sessionUrl: 'codex://session/port',
    })
    expect(history.get('run-suite')?.run?.current).toMatchObject({ status: 'done', resourceId: 'r-ext' })
    expect(history.get('report')?.['evaluation-export']?.current).toMatchObject({ status: 'done', resourceId: 't1' })
  })

  it('normalizes every persisted status without losing external ownership', () => {
    const history = deriveFeatureExternalHistory({
      runs: [
        run({ feature: 'run-passed', status: 'passed', healMode: 'external', endedAt: '2026-01-01T00:08:00Z' }),
        run({ feature: 'run-failed', runId: 'r-failed', status: 'failed', healMode: 'external' }),
        run({ feature: 'run-aborted', runId: 'r-aborted', status: 'aborted', healMode: 'external' }),
        run({ feature: 'run-healing', runId: 'r-healing', status: 'healing', healMode: 'external' }),
        run({ feature: 'run-verify', runId: 'r-verify', executionType: 'verify' }),
        run({ feature: 'ignored-boot', runId: 'r-boot', executionType: 'boot' }),
        run({ feature: 'ignored-benchmark', runId: 'r-benchmark', executionType: 'benchmark' }),
        run({ feature: 'internal-run', runId: 'r-internal' }),
      ],
      runDetails: {
        'r-verify': {
          manifest: {
            healMode: 'external',
            endedAt: '2026-01-01T00:07:00Z',
            externalHealSession: { clientKind: 'codex' },
          },
        },
      } as never,
      portifyWorkflows: [
        portify({ feature: 'port-saved', status: 'saved', producer: 'external', endedAt: '2026-01-01T00:07:00Z' }),
        portify({ feature: 'port-failed', workflowId: 'wf-failed', status: 'failed', producer: 'external' }),
        portify({ feature: 'port-aborted', workflowId: 'wf-aborted', status: 'aborted', producer: 'external' }),
        portify({ feature: 'port-ready', workflowId: 'wf-ready', status: 'ready-to-save', producer: 'external' }),
        portify({ feature: 'port-running', workflowId: 'wf-running', status: 'planning', producer: 'external' }),
      ],
      draftRecords: [
        draft({ featureName: 'draft-planning', status: 'planning', producer: 'external' }),
        draft({ featureName: 'draft-error', draftId: 'd-error', status: 'error', producer: 'external' }),
        draft({ featureName: 'draft-cancelled', draftId: 'd-cancelled', status: 'cancelled', producer: 'external' }),
        draft({ featureName: 'draft-rejected', draftId: 'd-rejected', status: 'rejected', producer: 'external' }),
        draft({ featureName: 'draft-ready', draftId: 'd-ready', status: 'spec-ready', producer: 'external' }),
        draft({ featureName: undefined, draftId: 'd-unpinned', producer: 'external' }),
      ],
      coverageJobs: [
        {
          jobId: 'j-running', feature: 'coverage-running', kind: 'summary', status: 'running',
          producer: 'external', startedAt: '2026-01-01T00:00:00Z',
        },
        {
          jobId: 'j-failed', feature: 'coverage-failed', kind: 'coverage', status: 'failed',
          producer: 'external', startedAt: '2026-01-01T00:00:00Z', endedAt: '2026-01-01T00:01:00Z',
        },
        {
          jobId: 'j-aborted', feature: 'coverage-aborted', kind: 'coverage', status: 'aborted',
          producer: 'external', startedAt: '2026-01-01T00:00:00Z',
        },
      ],
      exportTasks: [
        {
          taskId: 't-running', runId: 'r-running', feature: 'export-running', mode: 'raw',
          status: 'running', producer: 'external', createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:01:00Z', downloadReady: false, clientKind: 'claude',
          sessionId: 'export-session', conversationName: 'Export report',
        },
        {
          taskId: 't-failed', runId: 'r-export-failed', feature: 'export-failed', mode: 'raw',
          status: 'failed', producer: 'external', createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:01:00Z', downloadReady: false,
        },
      ],
    })

    expect(history.get('draft-planning')?.['specs-coverage']?.current?.status).toBe('running')
    expect(history.get('draft-error')?.['specs-coverage']?.current?.status).toBe('failed')
    expect(history.get('draft-cancelled')?.['specs-coverage']?.current?.status).toBe('aborted')
    expect(history.get('draft-rejected')?.['specs-coverage']?.current?.status).toBe('aborted')
    expect(history.get('draft-ready')?.['specs-coverage']?.current?.status).toBe('ready')
    expect(history.has('')).toBe(false)
    expect(history.get('coverage-running')?.['prd-summary']?.current?.status).toBe('running')
    expect(history.get('coverage-failed')?.['specs-coverage']?.current?.status).toBe('failed')
    expect(history.get('coverage-aborted')?.['specs-coverage']?.current?.status).toBe('aborted')
    expect(history.get('port-failed')?.portify?.current?.status).toBe('failed')
    expect(history.get('port-aborted')?.portify?.current?.status).toBe('aborted')
    expect(history.get('port-ready')?.portify?.current?.status).toBe('ready')
    expect(history.get('port-running')?.portify?.current?.status).toBe('running')
    expect(history.get('export-running')?.['evaluation-export']?.current).toMatchObject({
      status: 'running', clientKind: 'claude', sessionId: 'export-session', conversationName: 'Export report',
    })
    expect(history.get('export-failed')?.['evaluation-export']?.current?.status).toBe('failed')
    expect(history.get('run-passed')?.run?.current?.status).toBe('done')
    expect(history.get('run-failed')?.run?.current?.status).toBe('failed')
    expect(history.get('run-aborted')?.run?.current?.status).toBe('aborted')
    expect(history.get('run-healing')?.run?.current).toMatchObject({ kind: 'healing', status: 'running' })
    expect(history.get('run-verify')?.run?.current).toMatchObject({ kind: 'verifying', status: 'running', clientKind: 'codex' })
    expect(history.has('ignored-boot')).toBe(false)
    expect(history.has('ignored-benchmark')).toBe(false)
    expect(history.has('internal-run')).toBe(false)
  })

  it('keeps the newest producer per stage and combines different stages for one feature', () => {
    const history = deriveFeatureExternalHistory({
      runs: [run({
        feature: 'checkout', runId: 'r-external', status: 'passed', healMode: 'external',
        endedAt: '2026-01-01T00:07:00Z',
      })],
      portifyWorkflows: [portify({ feature: 'checkout', status: 'saved', producer: 'external' })],
      draftRecords: [
        draft({ draftId: 'd-new', producer: 'external', status: 'accepted', updatedAt: '2026-01-01T00:06:00Z' }),
        // Arrives later in the array but is older; it must not steal the stage.
        draft({ draftId: 'd-old', producer: 'internal', status: 'accepted', updatedAt: '2026-01-01T00:05:00Z' }),
      ],
    })

    expect(history.get('checkout')).toMatchObject({
      'specs-coverage': { current: { kind: 'authoring' } },
      portify: { current: { kind: 'portifying' } },
      run: { current: { kind: 'running' } },
    })
  })
})
