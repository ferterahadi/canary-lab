// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EvaluationExportTask, Feature, RunIndexEntry } from '@/shared/api/types'
import type { PortifyIndexEntry } from '@/shared/api/client'
import type { FeatureExternalHistory } from '../state/feature-activity'

// The two stores this hook reads own a WebSocket and a fetch loop apiece, which
// is the one edge a unit test can't reproduce. Everything the hook itself does
// — picking the latest terminal run per feature, folding in a completed export,
// dropping features with no evidence — runs for real against these values.
const runsValue: { runs: RunIndexEntry[] } = { runs: [] }
const exportsValue: { tasks: EvaluationExportTask[] } = { tasks: [] }
const portifyValue: { workflows: PortifyIndexEntry[] } = { workflows: [] }

vi.mock('@/features/runs', () => ({ useRuns: () => runsValue }))
vi.mock('@/features/evaluation', () => ({ useEvaluationExports: () => exportsValue }))
vi.mock('@/features/portify', () => ({
  isActivePortify: (status: PortifyIndexEntry['status']) =>
    status === 'planning' || status === 'editing' || status === 'verifying' || status === 'ready-to-save',
  usePortify: () => portifyValue,
}))

const { useDerivedFeatureStages } = await import('./derived-stages')

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  runsValue.runs = []
  exportsValue.tasks = []
  portifyValue.workflows = []
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const feature = (over: Partial<Feature> = {}): Feature => ({
  name: 'checkout',
  repos: [],
  envs: [],
  evidence: { envCapture: true, prdSummary: true, specs: true },
  ...over,
})

const run = (over: Partial<RunIndexEntry> = {}): RunIndexEntry => ({
  runId: 'r1',
  feature: 'checkout',
  startedAt: '2026-01-01T00:00:00Z',
  status: 'passed',
  ...over,
})

const task = (over: Partial<EvaluationExportTask> = {}): EvaluationExportTask => ({
  taskId: 't1',
  runId: 'r1',
  feature: 'checkout',
  mode: 'deterministic' as EvaluationExportTask['mode'],
  status: 'completed' as EvaluationExportTask['status'],
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  downloadReady: true,
  ...over,
})

let seen: Map<string, { key: string; status: string; evidence?: Record<string, unknown> }[]>

function Probe({ features, externalHistory }: { features: Feature[]; externalHistory?: FeatureExternalHistory }) {
  seen = useDerivedFeatureStages(features, externalHistory) as never
  return null
}

function render(features: Feature[], externalHistory?: FeatureExternalHistory): void {
  act(() => root.render(<Probe features={features} externalHistory={externalHistory} />))
}

const statusOf = (name: string, key: string): string | undefined =>
  seen.get(name)?.find((s) => s.key === key)?.status

describe('useDerivedFeatureStages', () => {
  it('derives a rail per feature that carries evidence', () => {
    render([feature()])
    expect(seen.has('checkout')).toBe(true)
    expect(statusOf('checkout', 'scout')).toBe('done')
  })

  it('omits a feature with no evidence block rather than inventing an empty rail', () => {
    // An older server sends no evidence; the caller falls back to the
    // all-pending rail plus a "not flown" chip, which it can only do if the
    // feature is absent from this map.
    render([feature({ name: 'legacy', evidence: undefined })])
    expect(seen.has('legacy')).toBe(false)
  })

  it('reflects the latest terminal run, ignoring in-flight ones', () => {
    runsValue.runs = [
      run({ runId: 'old', startedAt: '2026-01-01T00:00:00Z', status: 'failed' }),
      run({ runId: 'new', startedAt: '2026-02-01T00:00:00Z', status: 'passed' }),
      run({ runId: 'live', startedAt: '2026-03-01T00:00:00Z', status: 'running' }),
    ]
    render([feature()])
    expect(statusOf('checkout', 'run')).toBe('done')
  })

  it('marks the export stage done only for a completed export of that feature', () => {
    exportsValue.tasks = [task({ feature: 'other', status: 'completed' as EvaluationExportTask['status'] })]
    render([feature()])
    expect(statusOf('checkout', 'evaluation-export')).not.toBe('done')

    exportsValue.tasks = [task()]
    render([feature({ name: 'checkout' })])
    expect(statusOf('checkout', 'evaluation-export')).toBe('done')
  })

  it('does not count a still-running export as done', () => {
    exportsValue.tasks = [task({ status: 'running' as EvaluationExportTask['status'] })]
    render([feature()])
    expect(statusOf('checkout', 'evaluation-export')).not.toBe('done')
  })

  it('re-derives Parallel readiness from external Portify completion', () => {
    const externalPortify = {
      kind: 'portifying' as const,
      stage: 'portify' as const,
      resourceId: 'wf-live',
      status: 'done' as const,
      startedAt: '2026-08-25T00:00:00Z',
      updatedAt: '2026-08-25T00:05:00Z',
    }
    render([feature({ portified: false })], new Map([['checkout', {
      portify: {
        traces: [externalPortify],
        current: externalPortify,
      },
    }]]))
    expect(statusOf('checkout', 'portify')).toBe('done')
    expect(seen.get('checkout')?.find((stage) => stage.key === 'portify')?.evidence)
      .toEqual({ workflowId: 'wf-live' })
  })

  it('pins a standalone Portify workflow so Flight can hydrate its stage', () => {
    portifyValue.workflows = [{
      workflowId: 'wf-review',
      feature: 'checkout',
      status: 'ready-to-save',
      startedAt: '2026-08-25T00:00:00Z',
    }]
    render([feature({ portified: false })])
    expect(statusOf('checkout', 'portify')).toBe('pending')
    expect(seen.get('checkout')?.find((stage) => stage.key === 'portify')?.evidence)
      .toEqual({ workflowId: 'wf-review' })
  })

  it('marks a saved standalone Portify workflow done', () => {
    portifyValue.workflows = [{
      workflowId: 'wf-saved',
      feature: 'checkout',
      status: 'saved',
      startedAt: '2026-08-25T00:00:00Z',
    }]
    render([feature({ portified: false })])
    expect(statusOf('checkout', 'portify')).toBe('done')
    expect(seen.get('checkout')?.find((stage) => stage.key === 'portify')?.evidence)
      .toEqual({ workflowId: 'wf-saved' })
  })
})
