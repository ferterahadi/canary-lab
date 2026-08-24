// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CoverageJobIndexEntry, DraftRecord, EvaluationExportTask, RunDetail, RunIndexEntry } from '@/shared/api/types'
import type { PortifyIndexEntry } from '@/shared/api/client'
import type { FeatureActivity } from './feature-activity'

// The hook's only job is to compose the live stores and memoize the
// derivation; each store owns a WebSocket, which is the edge a unit test can't
// reproduce. The whole feature module is mocked because the store and its
// status predicate share one barrel, so `isActivePortify` / `isActiveWizardTask`
// are stubs here — the shipped versions of those, and every other rule in
// `deriveFeatureActivity`, are covered against the real module in
// feature-activity.test.ts. This suite proves composition and nothing else.
const stores = {
  runs: [] as RunIndexEntry[],
  runDetails: {} as Record<string, RunDetail>,
  workflows: [] as PortifyIndexEntry[],
  drafts: [] as DraftRecord[],
  tasks: [] as EvaluationExportTask[],
  coverageJobs: null as CoverageJobIndexEntry[] | null,
}

vi.mock('@/features/runs', () => ({
  useActiveRuns: () => ({ runs: stores.runs }),
  useRunDetails: () => stores.runDetails,
}))
vi.mock('@/features/evaluation', () => ({ useEvaluationExports: () => ({ tasks: stores.tasks }) }))
vi.mock('@/features/portify', async () => ({
  usePortify: () => ({ workflows: stores.workflows }),
  isActivePortify: (status: string) => status === 'editing' || status === 'running',
}))
vi.mock('@/features/wizard', async () => ({
  useWizardDrafts: () => ({ drafts: stores.drafts }),
  isActiveWizardTask: (status: string) => status === 'generating',
}))
// The coverage-jobs read rides useLiveResource (WS-invalidated fetch) — the
// same un-unit-testable edge as the stores, so it's stubbed the same way. The
// stub RUNS the fetcher it is handed (against a mocked API client), so the
// hook's wiring to the all-jobs endpoint is asserted, not assumed.
const liveReads: Array<{ topic: string; key: string; cache?: string }> = []
vi.mock('@/shared/state/use-live-resource', () => ({
  useLiveResource: (topic: string, key: string, fetcher: () => Promise<unknown>, opts?: { cache?: string }) => {
    liveReads.push({ topic, key, ...(opts?.cache ? { cache: opts.cache } : {}) })
    void fetcher()
    return { value: stores.coverageJobs }
  },
}))
vi.mock('@/shared/api/client', () => ({
  listAllCoverageJobs: vi.fn(async () => []),
}))

const { useFeatureActivity } = await import('./feature-activity')
const { listAllCoverageJobs } = await import('@/shared/api/client')

let container: HTMLDivElement
let root: Root
let seen: Map<string, FeatureActivity>

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  stores.runs = []
  stores.runDetails = {}
  stores.workflows = []
  stores.drafts = []
  stores.tasks = []
  stores.coverageJobs = null
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function Probe() {
  seen = useFeatureActivity()
  return null
}

const render = (): void => { act(() => root.render(<Probe />)) }

describe('useFeatureActivity', () => {
  it('is empty when every store is', () => {
    render()
    expect(seen.size).toBe(0)
  })

  it('wires the coverage-jobs read to the all-jobs endpoint on the coverage topic', () => {
    liveReads.length = 0
    render()
    expect(liveReads).toEqual([{ topic: 'coverage', key: 'all-jobs', cache: 'coverage-jobs' }])
    expect(listAllCoverageJobs).toHaveBeenCalled()
  })

  it('composes all the stores into one verb per feature', () => {
    stores.runs = [{ runId: 'r-a', feature: 'a', startedAt: '2026-01-01T00:00:00Z', status: 'running' }]
    stores.workflows = [{ workflowId: 'wf-b', feature: 'b', status: 'editing', startedAt: '2026-01-01T00:00:00Z' } as PortifyIndexEntry]
    stores.drafts = [{ draftId: 'd-c', featureName: 'c', status: 'generating' } as DraftRecord]
    stores.tasks = [{ taskId: 't-d', runId: 'r-d', feature: 'd', status: 'running' } as EvaluationExportTask]
    stores.coverageJobs = [{ jobId: 'j-e', feature: 'e', kind: 'coverage', status: 'running' } as CoverageJobIndexEntry]

    render()
    expect(seen.get('a')).toEqual({ kind: 'running', runId: 'r-a', external: false })
    expect(seen.get('b')).toEqual({ kind: 'portifying', workflowId: 'wf-b', external: false })
    expect(seen.get('c')).toEqual({ kind: 'authoring', draftId: 'd-c', external: false })
    expect(seen.get('d')).toEqual({ kind: 'exporting', taskId: 't-d', runId: 'r-d', external: false })
    expect(seen.get('e')).toEqual({ kind: 'mapping', jobId: 'j-e', external: false })
  })

  it('reads a run detail\'s external heal mode through the runDetails store', () => {
    stores.runs = [{ runId: 'r-x', feature: 'x', startedAt: '2026-01-01T00:00:00Z', status: 'healing' }]
    stores.runDetails = { 'r-x': { manifest: { healMode: 'external' } } as unknown as RunDetail }
    render()
    expect(seen.get('x')).toEqual({ kind: 'healing', runId: 'r-x', external: true })
  })

  it('lets the loudest verb win when one feature appears in several stores', () => {
    stores.runs = [{ runId: 'r-a', feature: 'shared', startedAt: '2026-01-01T00:00:00Z', status: 'running' }]
    stores.drafts = [{ draftId: 'd-a', featureName: 'shared', status: 'generating' } as DraftRecord]
    render()
    expect(seen.get('shared')).toEqual({ kind: 'running', runId: 'r-a', external: false })
    expect(seen.size).toBe(1)
  })
})
