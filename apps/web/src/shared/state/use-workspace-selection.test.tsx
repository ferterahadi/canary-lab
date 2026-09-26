import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Feature, RunDetail, RunIndexEntry } from '../api/types'
import type { DurableView, PersistedView } from '../lib/workspace-view-state'
import type { WorkspaceEvent, ConnectWorkspaceEventsOptions } from '../api/workspace-socket'
import type { RunsStreamFrame } from '@/features/runs/state/runs-state'
import type { WorkspaceNavigation } from './use-workspace-navigation'
import type { WorkspaceData } from './use-workspace-data'
import type { useWorkspaceSelection } from './use-workspace-selection'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const api = vi.hoisted(() => ({ listFeatures: vi.fn(), listFlights: vi.fn(), listPlanFeatures: vi.fn(),
  getVersionStatus: vi.fn(), listRuns: vi.fn(), getRunDetail: vi.fn() }))
vi.mock('../api/client', async (importOriginal) => ({ ...await importOriginal<typeof import('../api/client')>(), ...api }))
const viewState = vi.hoisted(() => ({ readPersistedView: vi.fn(), persistView: vi.fn(), onViewChangedInOtherTab: vi.fn() }))
vi.mock('../lib/workspace-view-state', () => viewState)
vi.mock('@/features/flights', async (importOriginal) => ({ ...await importOriginal<typeof import('@/features/flights')>(),
  useFlightsStream: () => ({ hydrated: false, flights: [], details: {} }),
}))
const workspace = vi.hoisted(() => ({ connect: vi.fn(), close: vi.fn(), options: null as ConnectWorkspaceEventsOptions | null }))
vi.mock('../api/workspace-socket', () => ({ connectWorkspaceEvents: workspace.connect }))

class RunSocket {
  static instances: RunSocket[] = []
  readyState = 0
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null
  constructor(public url: string) { RunSocket.instances.push(this) }
  close() { this.readyState = 3; this.onclose?.() }
}
const run = (runId: string, over: Partial<RunIndexEntry> = {}): RunIndexEntry => ({
  runId, feature: 'suite', status: 'passed', startedAt: '2026-01-01T00:00:00Z', ...over,
})
function detail(entry: RunIndexEntry): RunDetail {
  return { runId: entry.runId, manifest: { ...entry, healCycles: 0, services: [] } }
}
const feature = (name: string): Feature => ({ name, repos: [] } as unknown as Feature)
let root: Root
let container: HTMLDivElement
let nav: WorkspaceNavigation
let selection: ReturnType<typeof useWorkspaceSelection>
let data: WorkspaceData
let crossTab: (state: DurableView) => void
const invalidate = vi.fn()

async function mount(seed: Partial<PersistedView> = {}) {
  viewState.readPersistedView.mockReturnValue({ view: 'workspace', feature: 'suite', run: null, dialog: null,
    flight: null, flightStage: null, configTab: null, modelsAgent: null, focusTest: null, runTab: null, returnFlight: null, ...seed })
  vi.resetModules()
  const { useWorkspaceNavigation } = await import('./use-workspace-navigation')
  const { useWorkspaceSelection } = await import('./use-workspace-selection')
  const { useWorkspaceData } = await import('./use-workspace-data')
  const { RunsProvider, useRuns } = await import('@/features/runs/state/RunsContext')
  function Probe() {
    nav = useWorkspaceNavigation()
    const { runs } = useRuns()
    selection = useWorkspaceSelection({ allRuns: runs, selectedFeature: nav.selectedFeature, selectedRunId: nav.selectedRunId,
      setSelectedFeature: nav.setSelectedFeature, setSelectedRunId: nav.setSelectedRunId,
      selectedFeatureRef: nav.selectedFeatureRef, selectedRunIdRef: nav.selectedRunIdRef, pendingRunSelectionRef: nav.pendingRunSelectionRef })
    data = useWorkspaceData({ invalidate, onInitialFeatures: selection.onInitialFeatures,
      onFeaturesRefreshed: selection.onFeaturesRefreshed,
      selectedFeatureRef: nav.selectedFeatureRef, selectedRunIdRef: nav.selectedRunIdRef })
    return <output>{JSON.stringify({ feature: nav.selectedFeature, run: nav.selectedRunId,
      evidence: selection.selectedRunEvidence.manifest?.runId, status: selection.selectedRunEvidence.status })}</output>
  }
  await act(async () => root.render(<RunsProvider WebSocketImpl={RunSocket as unknown as typeof WebSocket}><Probe /></RunsProvider>))
}
async function frame(value: RunsStreamFrame) {
  await act(async () => { RunSocket.instances[0].onmessage?.({ data: JSON.stringify(value) }) })
}
async function index(runs: RunIndexEntry[], details: Record<string, RunDetail> = {}) {
  await frame({ type: 'snapshot', runs, details })
}
async function event(value: WorkspaceEvent) { await act(async () => { workspace.options?.onEvent(value) }) }

beforeEach(() => {
  vi.clearAllMocks()
  RunSocket.instances = []
  workspace.options = null
  workspace.connect.mockImplementation((options: ConnectWorkspaceEventsOptions) => {
    workspace.options = options
    return { close: workspace.close }
  })
  viewState.onViewChangedInOtherTab.mockImplementation((callback: typeof crossTab) => { crossTab = callback; return () => {} })
  api.listFeatures.mockResolvedValue([feature('suite'), feature('other')])
  api.listFlights.mockResolvedValue([])
  api.listPlanFeatures.mockResolvedValue({ tasks: [] })
  api.getVersionStatus.mockResolvedValue({ current: '1.0.0' })
  api.listRuns.mockResolvedValue([])
  api.getRunDetail.mockRejectedValue(new Error('Detail not loaded yet'))
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); container.remove(); vi.useRealTimers() })

describe('workspace selection through navigation, data, and run streams', () => {
  it('keeps a pending run selected while evidence falls back, then follows its arrival', async () => {
    await mount()
    const old = run('old')
    await index([old], { old: detail(old) })
    await act(async () => nav.selectStartedRun('new'))
    expect(nav.selectedRunId).toBe('new')
    expect(selection.selectedRunForFeature).toBeNull()
    expect(selection.selectedRunEvidence.manifest?.runId).toBe('old')
    expect(JSON.parse(container.textContent!)).toMatchObject({ run: 'new', evidence: 'old' })
    await event({ type: 'connected' })
    expect(nav.selectedRunId).toBe('new')
    expect(nav.pendingRunSelectionRef.current).toBe('new')
    const next = run('new', { status: 'running' })
    await index([next, old], { new: detail(next), old: detail(old) })
    expect(nav.pendingRunSelectionRef.current).toBeNull()
    expect(selection.selectedRunEvidence).toMatchObject({ manifest: { runId: 'new' }, status: 'running' })
    expect(JSON.parse(container.textContent!)).toMatchObject({ run: 'new', evidence: 'new', status: 'running' })
  })
  it('retains a historical URL selection through newer runs and reconnect without changing recorded source', async () => {
    await mount({ run: 'old', currentTests: false })
    const old = run('old')
    await index([run('new'), old], { old: detail(old) })
    await event({ type: 'connected' })
    expect(nav.selectedRunId).toBe('old')
    expect(nav.currentTests).toBe(false)
    expect(selection.selectedRunEvidence.manifest?.runId).toBe('old')
    expect(viewState.persistView).toHaveBeenLastCalledWith(expect.objectContaining({ feature: 'suite', run: 'old', currentTests: false }))
  })
  it('uses the supplied run order, includes verification, and preserves detail status precedence', async () => {
    await mount()
    const verify = run('verify', { executionType: 'verify', status: 'running' })
    await index([run('boot', { executionType: 'boot' }), verify, run('normal')], {
      verify: detail({ ...verify, status: 'failed' }),
    })
    expect(nav.selectedRunId).toBe('verify')
    expect(selection.featureRuns.map((entry) => entry.runId)).toEqual(['verify', 'normal'])
    expect(selection.selectedRunEvidence.status).toBe('failed')
  })
  it('initializes a missing suite selection and leaves a hydrated one alone', async () => {
    await mount({ feature: null })
    expect(nav.selectedFeature).toBe('suite')
    await act(async () => nav.setSelectedFeature('other'))
    await event({ type: 'connected' })
    expect(nav.selectedFeature).toBe('other')
  })
  it('follows selected-suite rename and chooses the latest eligible run under the new name', async () => {
    await mount({ run: 'old' })
    await index([run('new', { feature: 'renamed' }), run('old')])
    api.listFeatures.mockResolvedValue([feature('renamed'), feature('other')])
    await event({ type: 'feature-renamed', from: 'suite', to: 'renamed' })
    expect([nav.selectedFeature, nav.selectedRunId]).toEqual(['renamed', 'new'])
    expect(nav.pendingRunSelectionRef.current).toBeNull()
  })
  it('keeps the historical selection when another suite is renamed', async () => {
    await mount({ run: 'old' })
    await index([run('new'), run('old')])
    api.listFeatures.mockResolvedValue([feature('suite'), feature('renamed')])
    await event({ type: 'feature-renamed', from: 'other', to: 'renamed' })
    expect([nav.selectedFeature, nav.selectedRunId]).toEqual(['suite', 'old'])
  })
  it('falls back on deletion, clears the last suite, and handles a suite without runs', async () => {
    await mount({ run: 'old' })
    await index([run('old')])
    api.listFeatures.mockResolvedValue([feature('other')])
    await event({ type: 'feature-deleted', feature: 'suite' })
    expect([nav.selectedFeature, nav.selectedRunId]).toEqual(['other', null])
    api.listFeatures.mockResolvedValue([])
    await event({ type: 'feature-deleted', feature: 'other' })
    expect([nav.selectedFeature, nav.selectedRunId]).toEqual([null, null])
    expect(selection.selectedRunEvidence).toEqual({ manifest: undefined, summary: undefined, status: undefined })
  })
  it('falls back when an unguarded selected run disappears', async () => {
    await mount()
    await index([run('first'), run('second')])
    await act(async () => nav.setSelectedRunId('second'))
    await index([run('first')])
    expect(nav.selectedRunId).toBe('first')
  })
  it('preserves the distinct pending-guard behavior of suite clicks and review choices', async () => {
    await mount({ run: 'pending' })
    await act(async () => selection.selectFeatureForReview('other'))
    expect(nav.pendingRunSelectionRef.current).toBe('pending')
    await act(async () => selection.selectFeature('suite'))
    expect(nav.pendingRunSelectionRef.current).toBeNull()
  })
  it('keeps run arrival targets and return-to-Flight navigation paired during cross-tab changes', async () => {
    await mount()
    await index([run('first'), run('other-run', { feature: 'other' })])
    await act(async () => {
      nav.navigateToRun('suite', 'first', { test: 'failure' }, 'flight-1')
      nav.setCurrentTests(false)
    })
    expect(nav.focusTest).toEqual({ runId: 'first', test: 'failure' })
    expect(nav.returnFlight).toBe('flight-1')
    await act(async () => crossTab({ view: 'workspace', feature: 'other' }))
    expect(nav.selectedRunId).toBe('other-run')
    expect(nav.currentTests).toBe(true)
    expect(viewState.persistView).toHaveBeenLastCalledWith(expect.objectContaining({ feature: 'other', run: 'other-run', focusTest: null }))
  })
  it('does not let a delayed previous-run detail replace evidence for the selected run', async () => {
    let resolveOld: (value: RunDetail) => void = () => {}
    api.getRunDetail.mockImplementation((id: string) => id === 'old'
      ? new Promise<RunDetail>((resolve) => { resolveOld = resolve }) : Promise.resolve(detail(run('new'))))
    await mount({ run: 'old' })
    await index([run('new'), run('old')])
    await act(async () => nav.setSelectedRunId('new'))
    expect(selection.selectedRunEvidence.manifest?.runId).toBe('new')
    await act(async () => resolveOld(detail(run('old', { status: 'failed' }))))
    expect(selection.selectedRunEvidence.manifest?.runId).toBe('new')
    expect(selection.selectedRunEvidence.status).toBe('passed')
  })
  it('keeps callbacks and workspace socket stable across run updates without additional polling', async () => {
    vi.useFakeTimers()
    await mount()
    const callbacks = [selection.onInitialFeatures, selection.onFeaturesRefreshed, selection.selectFeature, selection.selectFeatureForReview]
    const entry = run('first')
    await index([entry], { first: detail(entry) })
    await frame({ type: 'update', runId: entry.runId, detail: detail({ ...entry, status: 'failed' }) })
    await act(async () => vi.advanceTimersByTimeAsync(5000))
    expect([selection.onInitialFeatures, selection.onFeaturesRefreshed, selection.selectFeature, selection.selectFeatureForReview]).toEqual(callbacks)
    expect(workspace.connect).toHaveBeenCalledTimes(1)
    expect(workspace.close).not.toHaveBeenCalled()
    expect(api.getRunDetail).not.toHaveBeenCalled()
    expect(api.listFeatures).toHaveBeenCalledTimes(1)
    expect(selection.selectedRunEvidence.status).toBe('failed')
    expect(JSON.parse(container.textContent!)).toMatchObject({ run: 'first', evidence: 'first', status: 'failed' })
  })
  it('uses the newest run index when a feature refresh completes later', async () => {
    let resolveFeatures: (features: Feature[]) => void = () => {}
    await mount()
    api.listFeatures.mockReturnValue(new Promise<Feature[]>((resolve) => { resolveFeatures = resolve }))
    await act(async () => data.refreshFeatures('other'))
    await index([run('arrived', { feature: 'other' })])
    await act(async () => resolveFeatures([feature('suite'), feature('other')]))
    expect([nav.selectedFeature, nav.selectedRunId]).toEqual(['other', 'arrived'])
  })
})
