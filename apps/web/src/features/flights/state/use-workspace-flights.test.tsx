import { act, useCallback, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CoverageJobIndexEntry, Feature, RunDetail, RunIndexEntry, DraftRecord, EvaluationExportTask } from '@/shared/api/types'
import type { FlightIndexEntry, PortifyIndexEntry, PortifyManifest } from '@/shared/api/client'
import { InvalidationProvider, useInvalidation } from '@/shared/state/invalidation'
import { useWorkspaceFlights } from './use-workspace-flights'

// Store values stand in for WebSocket snapshots. The controller, its domain
// derivations, invalidation provider, and coverage fetch/recovery hook run real.
const stores = vi.hoisted(() => ({
  runs: [] as RunIndexEntry[], activeRuns: [] as RunIndexEntry[], runDetails: {} as Record<string, RunDetail>,
  workflows: [] as PortifyIndexEntry[], portifyDetails: {} as Record<string, PortifyManifest>,
  drafts: [] as DraftRecord[], tasks: [] as EvaluationExportTask[],
}))
vi.mock('@/features/runs', async (importOriginal) => ({ ...await importOriginal<typeof import('@/features/runs')>(),
  useRuns: () => ({ runs: stores.runs }), useActiveRuns: () => ({ runs: stores.activeRuns }), useRunDetails: () => stores.runDetails,
}))
vi.mock('@/features/portify', async (importOriginal) => ({ ...await importOriginal<typeof import('@/features/portify')>(),
  usePortify: () => ({ workflows: stores.workflows, details: stores.portifyDetails }),
}))
vi.mock('@/features/evaluation', async (importOriginal) => ({ ...await importOriginal<typeof import('@/features/evaluation')>(),
  useEvaluationExports: () => ({ tasks: stores.tasks }),
}))
vi.mock('@/features/wizard', async (importOriginal) => ({ ...await importOriginal<typeof import('@/features/wizard')>(),
  useWizardDrafts: () => ({ drafts: stores.drafts, records: stores.drafts }),
}))
const api = vi.hoisted(() => ({ listAllCoverageJobs: vi.fn(), listFeatures: vi.fn() }))
vi.mock('@/shared/api/client', async (importOriginal) => ({ ...await importOriginal<typeof import('@/shared/api/client')>(), ...api }))

const feature = (name = 'checkout'): Feature => ({ name, repos: [], envs: [],
  evidence: { envCapture: true, prdSummary: true, specs: true },
})
const flight = (over: Partial<FlightIndexEntry> = {}): FlightIndexEntry => ({
  id: 'fl_1', flightId: 'fl_1', feature: 'checkout', repoPaths: [], status: 'running', currentStage: 'docs',
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', ...over,
})
const job = (over: Partial<CoverageJobIndexEntry> = {}): CoverageJobIndexEntry => ({
  jobId: 'job-1', feature: 'checkout', kind: 'coverage', status: 'running', startedAt: '2026-01-01T00:00:00Z', ...over,
})
let root: Root
let container: HTMLDivElement
let seen: ReturnType<typeof useWorkspaceFlights>
let invalidate: ReturnType<typeof useInvalidation>['invalidate']
const refreshed = vi.fn()
const invalidated = vi.fn()
const initialFeatures = [feature()]
const noFlights: FlightIndexEntry[] = []

function Probe({ flights, selectedFeature }: { flights: FlightIndexEntry[]; selectedFeature: string | null }) {
  const [features, setFeatures] = useState(initialFeatures)
  const dispatch = useInvalidation()
  invalidate = dispatch.invalidate
  const refreshFeatures = useCallback(() => {
    refreshed()
    void api.listFeatures().then(setFeatures)
  }, [])
  const invalidateCoverage = useCallback(() => { invalidated(); dispatch.invalidate('coverage') }, [dispatch.invalidate])
  seen = useWorkspaceFlights({ features, flights, selectedFeature, refreshFeatures, invalidateCoverage })
  return <output>{JSON.stringify({ activity: seen.selectedFeatureActivity?.kind ?? null,
    coverage: seen.coverageJobs.map((entry) => entry.status),
    suites: seen.featuresWithPending.map((entry) => ({ name: entry.name, pending: !!entry.pending })),
    docs: seen.derivedStages.get('checkout')?.find((stage) => stage.key === 'docs')?.status })}</output>
}
async function render(flights = noFlights, selectedFeature: string | null = 'checkout') {
  await act(async () => root.render(<InvalidationProvider><Probe flights={flights} selectedFeature={selectedFeature} /></InvalidationProvider>))
}
async function event() { await act(async () => invalidate('coverage')) }
async function advance(ms = 2500) { await act(async () => vi.advanceTimersByTimeAsync(ms)) }
const output = () => JSON.parse(container.textContent!)

beforeEach(async () => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  stores.runs = []; stores.activeRuns = []; stores.runDetails = {}
  stores.workflows = []; stores.portifyDetails = {}; stores.drafts = []; stores.tasks = []
  api.listAllCoverageJobs.mockResolvedValue([])
  api.listFeatures.mockResolvedValue(initialFeatures)
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
  // Settle the shared remount cache through its public reader before each case.
  await render()
  refreshed.mockClear(); invalidated.mockClear(); api.listFeatures.mockClear(); api.listAllCoverageJobs.mockClear()
})
afterEach(() => { act(() => root.unmount()); container.remove(); vi.useRealTimers() })

describe('workspace Flight presentation and refresh coordination', () => {
  it('shares standalone evidence between picker rails and suite actions without inventing a recorded Flight', async () => {
    expect(seen.flightAction('checkout')?.flightId).toBe('feature:checkout')
    expect(seen.pickerFeatures[0].stages).toBe(seen.derivedStages.get('checkout'))
    expect(seen.featuresWithPending).toBe(initialFeatures)
    expect(seen.coverageGeneratingFlight).toBeNull()
    const action = seen.flightAction
    await render()
    expect(seen.flightAction).toBe(action)
    expect(api.listAllCoverageJobs).not.toHaveBeenCalled()
    expect(refreshed).not.toHaveBeenCalled()
    expect(invalidated).not.toHaveBeenCalled()
  })
  it('uses recorded Flight order and replaces a pending suite when real metadata arrives', async () => {
    const flights = [flight({ feature: 'new', flightId: 'first', group: 'batch' }), flight({ feature: 'new', flightId: 'second' })]
    await render(flights)
    expect(seen.flightAction('new')?.flightId).toBe('first')
    expect(output().suites).toEqual([{ name: 'checkout', pending: false }, { name: 'new', pending: true }])
    expect(seen.pickerFeatures.map((entry) => entry.name)).toEqual(['checkout'])
    api.listFeatures.mockResolvedValue([feature(), feature('new')])
    api.listAllCoverageJobs.mockResolvedValue([job()])
    await event()
    expect(output().suites).toEqual([{ name: 'checkout', pending: false }, { name: 'new', pending: false }])
    expect(seen.pickerFeatures.map((entry) => entry.name)).toEqual(['checkout', 'new'])
  })
  it('reflects activity snapshots and selection without refreshing coverage', async () => {
    stores.activeRuns = [{ runId: 'r', feature: 'checkout', status: 'running', startedAt: '2026-01-01T00:00:00Z' }]
    await render()
    expect(output().activity).toBe('running')
    expect(seen.activity.get('checkout')).toBe(seen.selectedFeatureActivity)
    expect(seen.flightAction('checkout')?.live).toBe(true)
    await render(noFlights, null)
    expect(output().activity).toBeNull()
    await render(noFlights, 'other')
    expect(seen.selectedFeatureActivity).toBeUndefined()
    expect(refreshed).not.toHaveBeenCalled()
    expect(api.listAllCoverageJobs).not.toHaveBeenCalled()
  })
  it('updates an open consumer on a coverage event without a refresh loop', async () => {
    api.listAllCoverageJobs.mockResolvedValue([job()])
    await event()
    expect(output()).toMatchObject({ activity: 'mapping', coverage: ['running'] })
    expect(refreshed).toHaveBeenCalledTimes(1)
    expect(invalidated).toHaveBeenCalledTimes(1)
    // Event read + the existing invalidation after a changed job signature.
    expect(api.listAllCoverageJobs).toHaveBeenCalledTimes(2)
    await event()
    expect(refreshed).toHaveBeenCalledTimes(1)
    expect(invalidated).toHaveBeenCalledTimes(1)
  })
  it('recovers a missed completion after 2.5 seconds and refreshes suite evidence in the same mounted view', async () => {
    api.listAllCoverageJobs.mockResolvedValue([job()])
    await event()
    const refreshedFeature = { ...feature(), evidence: { envCapture: true, prdSummary: false, specs: true } }
    api.listFeatures.mockResolvedValue([refreshedFeature])
    api.listAllCoverageJobs.mockResolvedValue([job({ status: 'done' })])
    await advance(2499)
    expect(output().coverage).toEqual(['running'])
    await advance(1)
    expect(output()).toMatchObject({ activity: null, coverage: ['done'], docs: 'pending' })
    expect(refreshed).toHaveBeenCalledTimes(2)
    expect(invalidated).toHaveBeenCalledTimes(2)
    const reads = api.listAllCoverageJobs.mock.calls.length
    await advance(7500)
    expect(api.listAllCoverageJobs).toHaveBeenCalledTimes(reads)
  })
  it('retains a running job on failed reads and retries until completion', async () => {
    api.listAllCoverageJobs.mockResolvedValue([job()])
    await event()
    api.listAllCoverageJobs.mockRejectedValueOnce(new Error('offline'))
    await advance()
    expect(output().coverage).toEqual(['running'])
    expect(refreshed).toHaveBeenCalledTimes(1)
    api.listAllCoverageJobs.mockResolvedValue([job({ status: 'failed' })])
    await advance()
    expect(output().coverage).toEqual(['failed'])
    expect(refreshed).toHaveBeenCalledTimes(2)
  })
  it('preserves ordered job signatures for additions, reorder, and removal', async () => {
    const first = job({ status: 'done' }); const second = job({ jobId: 'job-2', status: 'done' })
    for (const snapshot of [[first], [first, second], [second, first], []]) {
      api.listAllCoverageJobs.mockResolvedValue(snapshot)
      await event()
    }
    expect(refreshed).toHaveBeenCalledTimes(4)
    expect(invalidated).toHaveBeenCalledTimes(4)
  })
  it('does not refresh merely because a cached snapshot is present on remount', async () => {
    api.listAllCoverageJobs.mockResolvedValue([job({ status: 'done' })])
    await event()
    act(() => root.unmount())
    refreshed.mockClear(); invalidated.mockClear()
    root = createRoot(container)
    await render()
    expect(output().coverage).toEqual(['done'])
    expect(refreshed).not.toHaveBeenCalled()
    expect(invalidated).not.toHaveBeenCalled()
  })
  it('refreshes when initial hydration discovers jobs and stops recovery when unmounted', async () => {
    act(() => root.unmount())
    root = createRoot(container)
    api.listAllCoverageJobs.mockResolvedValue([job()])
    await render()
    expect(refreshed).toHaveBeenCalledTimes(1)
    expect(output().coverage).toEqual(['running'])
    act(() => root.unmount())
    const reads = api.listAllCoverageJobs.mock.calls.length
    await advance(7500)
    expect(api.listAllCoverageJobs).toHaveBeenCalledTimes(reads)
    root = createRoot(container)
  })
})
