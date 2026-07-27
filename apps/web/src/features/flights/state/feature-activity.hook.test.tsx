// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DraftRecord, EvaluationExportTask, RunIndexEntry } from '@/shared/api/types'
import type { PortifyIndexEntry } from '@/shared/api/client'
import type { FeatureActivity } from './feature-activity'

// The hook's only job is to compose the four live stores and memoize the
// derivation; each store owns a WebSocket, which is the edge a unit test can't
// reproduce. The whole feature module is mocked because the store and its
// status predicate share one barrel, so `isActivePortify` / `isActiveWizardTask`
// are stubs here — the shipped versions of those, and every other rule in
// `deriveFeatureActivity`, are covered against the real module in
// feature-activity.test.ts. This suite proves composition and nothing else.
const stores = {
  runs: [] as RunIndexEntry[],
  workflows: [] as PortifyIndexEntry[],
  drafts: [] as DraftRecord[],
  tasks: [] as EvaluationExportTask[],
}

vi.mock('@/features/runs', () => ({ useActiveRuns: () => ({ runs: stores.runs }) }))
vi.mock('@/features/evaluation', () => ({ useEvaluationExports: () => ({ tasks: stores.tasks }) }))
vi.mock('@/features/portify', async () => ({
  usePortify: () => ({ workflows: stores.workflows }),
  isActivePortify: (status: string) => status === 'editing' || status === 'running',
}))
vi.mock('@/features/wizard', async () => ({
  useWizardDrafts: () => ({ drafts: stores.drafts }),
  isActiveWizardTask: (status: string) => status === 'generating',
}))

const { useFeatureActivity } = await import('./feature-activity')

let container: HTMLDivElement
let root: Root
let seen: Map<string, FeatureActivity>

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  stores.runs = []
  stores.workflows = []
  stores.drafts = []
  stores.tasks = []
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

  it('composes all four stores into one verb per feature', () => {
    stores.runs = [{ runId: 'r-a', feature: 'a', startedAt: '2026-01-01T00:00:00Z', status: 'running' }]
    stores.workflows = [{ workflowId: 'wf-b', feature: 'b', status: 'editing', startedAt: '2026-01-01T00:00:00Z' } as PortifyIndexEntry]
    stores.drafts = [{ draftId: 'd-c', featureName: 'c', status: 'generating' } as DraftRecord]
    stores.tasks = [{ taskId: 't-d', runId: 'r-d', feature: 'd', status: 'running' } as EvaluationExportTask]

    render()
    expect(seen.get('a')).toEqual({ kind: 'running', runId: 'r-a' })
    expect(seen.get('b')).toEqual({ kind: 'portifying', workflowId: 'wf-b' })
    expect(seen.get('c')).toEqual({ kind: 'authoring', draftId: 'd-c' })
    expect(seen.get('d')).toEqual({ kind: 'exporting', taskId: 't-d', runId: 'r-d' })
  })

  it('lets the loudest verb win when one feature appears in several stores', () => {
    stores.runs = [{ runId: 'r-a', feature: 'shared', startedAt: '2026-01-01T00:00:00Z', status: 'running' }]
    stores.drafts = [{ draftId: 'd-a', featureName: 'shared', status: 'generating' } as DraftRecord]
    render()
    expect(seen.get('shared')).toEqual({ kind: 'running', runId: 'r-a' })
    expect(seen.size).toBe(1)
  })
})
