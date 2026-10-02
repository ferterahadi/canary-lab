// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FLIGHT_STAGE_KEYS, type FlightManifest } from '@shared/flights/types'
import type { CoverageJobManifest } from '@shared/coverage/types'
import { InvalidationProvider } from '@/shared/state/invalidation'
import { FlightPage } from './FlightPage'

const mocks = vi.hoisted(() => ({
  getFlight: vi.fn(),
  getCoverageJob: vi.fn(),
  getCoverageAgentSession: vi.fn(),
  getFlightAgentSession: vi.fn(async () => null),
  connect: vi.fn(() => ({ close: vi.fn() })),
}))
vi.mock('@/shared/api/flights', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/shared/api/flights')>()),
  getFlight: mocks.getFlight,
  getFlightAgentSession: mocks.getFlightAgentSession,
  getFlightRemedy: vi.fn(async () => ({ remedy: null })),
}))
vi.mock('@/shared/api/coverage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/shared/api/coverage')>()),
  getCoverageJob: mocks.getCoverageJob,
  getCoverageAgentSession: mocks.getCoverageAgentSession,
  listFeatureDocs: vi.fn(async () => ({ docs: [], sourceDocCount: 0, hasPrdSummary: false, docsDrift: false })),
  getFeatureCoverage: vi.fn(async () => null),
}))
vi.mock('@/shared/api/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/shared/api/config')>()),
  getFeatureConfigDoc: vi.fn(async () => null),
  getEnvsetsIndex: vi.fn(async () => null),
}))
vi.mock('@/shared/api/agent-session-socket', () => ({ connectAgentSessionStream: mocks.connect }))
vi.mock('@/features/portify/state/PortifyContext', async () => {
  const { detailFixture } = await import('../../portify/state/portify-detail.fixture')
  return ({
  usePortify: () => ({ workflows: [], loadPortify: vi.fn() }),
  usePortifyWorkflow: () => null,
  usePortifyDetail: detailFixture(async () => undefined),
}) })
vi.mock('@/features/evaluation/state/EvaluationExportContext', () => ({
  useEvaluationExports: () => ({ tasks: [], taskById: () => null }),
  useEvaluationExportLog: () => ({ log: '', watchTask: vi.fn() }),
}))
vi.mock('@/features/runs/state/RunsContext', () => ({
  useRuns: () => ({ runs: [] }),
  useRun: () => ({ detail: null }),
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const summary: CoverageJobManifest = {
  jobId: 'summary-1', feature: 'checkout', kind: 'summary', status: 'running',
  startedAt: '2026-09-11T09:00:00.000Z', log: '',
}
const mapping: CoverageJobManifest = {
  jobId: 'mapping-1', feature: 'checkout', kind: 'coverage', status: 'running',
  startedAt: '2026-09-11T09:01:00.000Z', chainedFromJobId: summary.jobId, log: '',
}
const flight: FlightManifest = {
  flightId: 'fl_coverage', feature: 'checkout', description: '', repoPaths: [],
  opts: { env: 'local', coverageTarget: 100, yolo: false },
  status: 'paused', currentStage: 'docs', createdAt: '2026-09-10T00:00:00.000Z', updatedAt: '2026-09-10T00:00:00.000Z',
  stages: FLIGHT_STAGE_KEYS.map((key) => ({ key, status: 'pending' })),
}
let container: HTMLDivElement
let root: Root
let jobs: CoverageJobManifest[]

beforeEach(() => {
  vi.clearAllMocks()
  jobs = [summary]
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  mocks.getFlight.mockResolvedValue(flight)
  mocks.getCoverageJob.mockImplementation(async (id: string) => jobs.find((job) => job.jobId === id))
  mocks.getCoverageAgentSession.mockImplementation(async (id: string) => ({
    agent: 'claude', sessionId: id,
    events: [{ kind: 'assistant-message', timestamp: '2026-09-11T09:00:10.000Z', text: id === summary.jobId ? 'Extracting requirements from spec.md' : 'Linking R1 to checkout.spec.ts' }],
  }))
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})
async function render(stage?: 'docs' | 'specs-coverage') {
  await act(async () => root.render(
    <InvalidationProvider>
      <FlightPage flightId={flight.flightId} coverageJobs={jobs} onClose={vi.fn()} onSelectFlight={vi.fn()}
        {...(stage ? { stage, onSelectStage: vi.fn() } : {})} />
    </InvalidationProvider>,
  ))
}
const text = () => container.textContent ?? ''
async function expandActivity() {
  await act(async () => container.querySelector('[data-testid="stage-activity-resize"]')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })))
}

describe('Flight generation Activity', () => {
  it('opens recalculation Activity on Requirements and preserves the selection through discovery and mapping', async () => {
    const selectStage = vi.fn()
    const renderRecovery = async (id: string) => {
      await act(async () => root.render(<InvalidationProvider>
        <FlightPage flightId={id} liveFlight={{ ...flight, flightId: id }} coverageJobs={jobs}
          stage="docs" onSelectStage={selectStage} onClose={vi.fn()} onSelectFlight={vi.fn()}
          recalculation={{ feature: 'checkout', stage: 'prd-summary', request: 1, status: 'started' }} />
      </InvalidationProvider>))
    }
    await renderRecovery('fl_loading')
    expect(text()).toContain('Extracting requirements from spec.md')
    jobs = [{ ...summary, status: 'done' }, mapping]
    await renderRecovery('fl_resolved')
    expect(selectStage).not.toHaveBeenCalledWith(null)
    expect(text()).toContain('Extracting requirements from spec.md')
    expect(text()).not.toContain('Linking R1 to checkout.spec.ts')
  })

  it('shows a launch failure with a retry on the destination', async () => {
    const retry = vi.fn()
    await act(async () => root.render(<InvalidationProvider>
      <FlightPage flightId={flight.flightId} coverageJobs={[]} stage="docs" onSelectStage={vi.fn()}
        onClose={vi.fn()} onSelectFlight={vi.fn()} onRetryRecalculation={retry}
        recalculation={{ feature: 'checkout', stage: 'prd-summary', request: 1, status: 'failed', error: 'Launch unavailable' }} />
    </InvalidationProvider>))
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Launch unavailable')
    const button = [...container.querySelectorAll('button')].find((node) => node.textContent === 'Retry recalculation')!
    act(() => button.click())
    expect(retry).toHaveBeenCalledOnce()
  })

  it('follows the summary and mapping stages using their actual coverage sessions', async () => {
    await render()
    expect(text()).toContain('Extracting requirements from spec.md')
    expect(text()).not.toContain('Paused before this step')
    expect(container.querySelector('[data-testid="flight-status"]')?.textContent).not.toContain('Idle')
    expect(mocks.getCoverageAgentSession).toHaveBeenCalledWith(summary.jobId)
    expect(mocks.getFlightAgentSession).not.toHaveBeenCalled()
    jobs = [{ ...summary, status: 'done', endedAt: mapping.startedAt, chainedJobId: mapping.jobId }, mapping]
    await render()
    expect(text()).toContain('Linking R1 to checkout.spec.ts')
    expect(container.querySelector('[data-testid="specs-pass-skeleton"]')).toBeNull()
    expect(mocks.getCoverageAgentSession).toHaveBeenCalledWith(mapping.jobId)
    expect(mocks.connect).toHaveBeenCalledWith(expect.objectContaining({ source: expect.objectContaining({ kind: 'coverage', jobId: mapping.jobId }) }))
  })

  it('reopens both completed stages with their session history and no live tail', async () => {
    jobs = [{ ...summary, status: 'done' }, { ...mapping, status: 'done' }]
    await render('docs')
    await expandActivity()
    expect(text()).toContain('Extracting requirements from spec.md')
    expect(text()).toContain('Summarizing docs done.')
    await render('specs-coverage')
    await expandActivity()
    expect(text()).toContain('Linking R1 to checkout.spec.ts')
    expect(text()).toContain('Mapping coverage done.')
    expect(mocks.connect).not.toHaveBeenCalled()
  })

  it('keeps failed mapping activity and its error readable after completion', async () => {
    await render()
    jobs = [{ ...summary, status: 'done' }, { ...mapping, status: 'failed', error: 'Mapping answer did not account for R2' }]
    await render('specs-coverage')
    await expandActivity()
    expect(text()).toContain('Mapping answer did not account for R2')
    expect(text()).toContain('Linking R1 to checkout.spec.ts')
  })

  it('respects an explicit stage choice while mapping continues', async () => {
    jobs = [{ ...summary, status: 'done' }, mapping]
    await render('docs')
    await expandActivity()
    expect(text()).toContain('Extracting requirements from spec.md')
    expect(text()).not.toContain('Linking R1 to checkout.spec.ts')
  })
})
