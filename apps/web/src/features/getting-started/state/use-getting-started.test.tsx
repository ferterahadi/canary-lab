import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FlightEntryOptions, OnboardingSamples, OnboardingWorkflow, OnboardingWorkflowAction } from '@/shared/api/client'
import type { RunIndexEntry } from '@/shared/api/types'
import { ApiError } from '@/shared/api/internal'
import { InvalidationProvider, useInvalidation } from '@/shared/state/invalidation'
import { DemoDialog } from '../components/DemoDialog'
import { useGettingStarted } from './use-getting-started'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const api = vi.hoisted(() => ({
  getOnboardingSamples: vi.fn(), getProjectConfig: vi.fn(), putProjectConfig: vi.fn(),
  startRun: vi.fn(), startFlight: vi.fn(), startCoverageJob: vi.fn(), getFlightEntryOptions: vi.fn(),
}))
vi.mock('@/shared/api/client', async () => ({ ...api, ApiError: (await import('@/shared/api/internal')).ApiError }))

const navigation = {
  setDemoOpen: vi.fn(), setSelectedFeature: vi.fn(), navigateToRun: vi.fn(),
  navigateToCoverage: vi.fn(), openFlight: vi.fn(), openFlightStage: vi.fn(), openFeatureStage: vi.fn(),
}
function workflow(id: 'run' | 'export'): OnboardingWorkflow {
  return { id, group: 'start', order: 1, title: id, outcome: 'outcome', steps: [], skill: '/canary-lab-run',
    externalPrompt: 'prompt', internalAction: { kind: id, feature: 'sample' }, unavailableReason: null }
}
function catalog(): OnboardingSamples {
  return { sampleSuite: 'sample', sampleFlightRepo: null, sampleFlightDescription: null,
    workflows: [workflow('run'), workflow('export')], session: { active: null, completed: {} } }
}
function entry(over: Partial<FlightEntryOptions> = {}): FlightEntryOptions {
  return { feature: 'sample', flight: null, active: false, canContinue: false, stages: [],
    prefill: { repoPaths: ['/workspace/product'], description: 'product', env: 'local', coverageTarget: 85 }, ...over }
}
const run = (over: Partial<RunIndexEntry> = {}): RunIndexEntry => ({
  runId: 'run-1', feature: 'sample', startedAt: '2026-01-01T00:00:00Z', status: 'passed', ...over,
})
let root: Root
let container: HTMLDivElement
let controller: ReturnType<typeof useGettingStarted>
let invalidate: ReturnType<typeof useInvalidation>['invalidate']
let runs: RunIndexEntry[]
function Probe() {
  invalidate = useInvalidation().invalidate
  controller = useGettingStarted({ allRuns: runs, flights: [], ...navigation })
  const { demo } = controller
  return <DemoDialog open onClose={() => {}} workflows={demo.workflows} session={demo.session}
    actionBlockers={controller.actionBlockers} onInternalAction={controller.launchDemo}
    onOpenTarget={controller.openTarget} showDemo={demo.showDemo} onShowDemoChange={demo.setShowDemo} />
}
async function render() {
  await act(async () => { root.render(<InvalidationProvider><Probe /></InvalidationProvider>) })
}
async function launch(action: OnboardingWorkflowAction) {
  await act(async () => { await controller.launchDemo(action) })
}
beforeEach(() => {
  vi.clearAllMocks()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  runs = []
  window.localStorage.clear()
  api.getOnboardingSamples.mockResolvedValue(catalog())
  api.getProjectConfig.mockResolvedValue({ showDemo: true })
  api.putProjectConfig.mockResolvedValue(undefined)
  api.startRun.mockResolvedValue({ runId: 'new-run' })
  api.startFlight.mockResolvedValue({ flightId: 'new-flight' })
  api.startCoverageJob.mockResolvedValue({})
  api.getFlightEntryOptions.mockResolvedValue(entry())
})
afterEach(() => { act(() => root.unmount()); container.remove(); vi.useRealTimers() })

describe('Getting Started controller', () => {
  it('auto-opens once and records that the chooser was seen', async () => {
    await render()
    expect(navigation.setDemoOpen).toHaveBeenCalledExactlyOnceWith(true)
    expect(window.localStorage.getItem('canary-lab:demo-seen')).toBe('1')
    await render()
    expect(navigation.setDemoOpen).toHaveBeenCalledTimes(1)
    act(() => controller.openDemo())
    expect(navigation.setDemoOpen).toHaveBeenCalledTimes(2)
  })
  it.each(['run', 'heal'] as const)('launches %s with its own attribution before navigating', async (kind) => {
    await render()
    await launch({ kind, feature: 'sample' })
    expect(api.startRun).toHaveBeenCalledWith('sample', { gettingStartedSource: 'internal', gettingStartedWorkflow: kind })
    expect(navigation.setSelectedFeature).toHaveBeenCalledWith('sample')
    expect(navigation.setDemoOpen).toHaveBeenLastCalledWith(false)
    expect(navigation.navigateToRun).toHaveBeenCalledWith('sample', 'new-run')
  })
  it.each([['/workspace/product/', 'product'], ['C:\\workspace\\product', 'product'], ['/', 'flight-app']])(
    'launches a Flight from %s', async (repoPath, feature) => {
      await render()
      await launch({ kind: 'flight', repoPath, description: 'flow' })
      expect(api.startFlight).toHaveBeenCalledWith({ feature, repoPaths: [repoPath], description: 'flow', gettingStartedSource: 'internal' })
      expect(navigation.openFlight).toHaveBeenCalledWith('new-flight')
    })
  it.each([false, true])('opens standalone Coverage, including an existing job (%s)', async (busy) => {
    await render()
    if (busy) api.startCoverageJob.mockRejectedValue(new ApiError(409, 'busy'))
    await launch({ kind: 'coverage', feature: 'sample' })
    expect(api.startCoverageJob).toHaveBeenCalledWith('sample', 'coverage', { gettingStartedSource: 'internal' })
    expect(api.startFlight).not.toHaveBeenCalled()
    expect(navigation.navigateToCoverage).toHaveBeenCalledWith('sample')
  })
  it.each([
    ['author', 'specs-coverage'], ['portify', 'portify'], ['export', 'evaluation-export'],
  ] as const)('launches %s at its Flight stage', async (kind, stage) => {
    await render()
    await launch({ kind, feature: 'sample' })
    expect(api.startFlight).toHaveBeenCalledWith(expect.objectContaining({ fromStage: stage, gettingStartedWorkflow: kind }))
    expect(navigation.openFlightStage).toHaveBeenCalledWith('new-flight', stage)
  })
  it.each(['active', 'paused', 'settled'] as const)('reuses the %s Flight correctly', async (state) => {
    api.getFlightEntryOptions.mockResolvedValue(entry({
      flight: { flightId: 'existing' } as NonNullable<FlightEntryOptions['flight']>,
      active: state === 'active', canContinue: state === 'paused',
    }))
    await render()
    await launch({ kind: 'author', feature: 'sample' })
    if (state === 'active') {
      expect(api.startFlight).not.toHaveBeenCalled()
      expect(navigation.openFlightStage).toHaveBeenCalledWith('existing', 'specs-coverage')
    } else {
      expect(api.startFlight).toHaveBeenCalledWith(expect.objectContaining({ mode: state === 'paused' ? 'continue' : 'jump' }))
    }
  })
  it.each([
    ['run', 'startRun'], ['flight', 'startFlight'], ['coverage', 'startCoverageJob'], ['author', 'getFlightEntryOptions'],
  ] as const)('keeps the chooser and destination when %s fails', async (kind, request) => {
    await render()
    navigation.setDemoOpen.mockClear()
    const error = new Error('offline')
    api[request].mockRejectedValue(error)
    const action: OnboardingWorkflowAction = kind === 'flight'
      ? { kind, repoPath: '/workspace/product', description: 'flow' } : { kind, feature: 'sample' }
    await expect(launch(action)).rejects.toBe(error)
    expect(navigation.setDemoOpen).not.toHaveBeenCalled()
    expect(navigation.setSelectedFeature).not.toHaveBeenCalled()
  })
  it('propagates a coverage API failure other than conflict', async () => {
    await render()
    api.startCoverageJob.mockRejectedValue(new ApiError(500, 'failed'))
    await expect(launch({ kind: 'coverage', feature: 'sample' })).rejects.toMatchObject({ status: 500 })
    expect(navigation.navigateToCoverage).not.toHaveBeenCalled()
  })
  it.each(['run', undefined, 'boot', 'verify', 'benchmark'] as const)('gates export using normal passed runs (%s)', async (executionType) => {
    runs = [run({ executionType })]
    await render()
    expect(controller.actionBlockers.export).toBe(executionType === 'run' || executionType === undefined ? undefined : 'Complete Run and Heal first.')
  })
  it('does not enable export for another suite, failed runs, or an unavailable action', async () => {
    runs = [run({ feature: 'other' }), run({ status: 'failed' })]
    await render()
    expect(controller.actionBlockers.export).toBeDefined()
    api.getOnboardingSamples.mockResolvedValue({ ...catalog(), workflows: [{ ...workflow('export'), internalAction: null }] })
    await act(async () => invalidate('onboarding'))
    expect(controller.actionBlockers.export).toBeDefined()
  })
  it('opens every target on its existing destination', async () => {
    await render()
    controller.openTarget({ kind: 'flight', id: 'fl' })
    expect(navigation.openFlight).toHaveBeenCalledWith('fl')
    controller.openTarget({ kind: 'coverage-job', id: 'job', feature: 'sample' })
    expect(navigation.navigateToCoverage).toHaveBeenCalledWith('sample')
    for (const [kind, stage] of [['draft', 'specs-coverage'], ['portify', 'portify'], ['export', 'evaluation-export']] as const) {
      controller.openTarget({ kind, id: 'task', feature: 'sample' })
      expect(navigation.openFeatureStage).toHaveBeenLastCalledWith('sample', stage)
    }
    controller.openTarget({ kind: 'run', id: 'not-loaded' })
    expect(navigation.navigateToRun).toHaveBeenLastCalledWith('sample', 'not-loaded')
    runs = [run({ feature: 'actual' })]
    await render()
    controller.openTarget({ kind: 'run', id: 'run-1' })
    expect(navigation.navigateToRun).toHaveBeenLastCalledWith('actual', 'run-1')
  })
  it('closes without guessing when neither a run nor a run workflow can resolve its suite', async () => {
    api.getOnboardingSamples.mockResolvedValue({ ...catalog(), workflows: [] })
    await render()
    controller.openTarget({ kind: 'run', id: 'missing' })
    expect(navigation.navigateToRun).not.toHaveBeenCalled()
    expect(navigation.setDemoOpen).toHaveBeenLastCalledWith(false)
  })
  it.each(['push', 'missed-push'] as const)('updates the open dialog after an external start and completion via %s', async (delivery) => {
    vi.useFakeTimers()
    await render()
    const dialog = document.querySelector('[data-testid="demo-dialog"]')
    const active = { sessionId: 'external', workflow: 'run', owner: 'external', target: { kind: 'run', id: 'remote-run' },
      startedAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' } as const
    api.getOnboardingSamples.mockResolvedValue({ ...catalog(), session: { active, completed: {} } })
    const deliver = () => act(async () => {
      if (delivery === 'push') invalidate('onboarding')
      else await vi.advanceTimersByTimeAsync(5000)
    })
    await deliver()
    expect(controller.demo.session.active?.owner).toBe('external')
    expect(document.querySelector('[data-testid="demo-dialog"]')).toBe(dialog)
    expect(document.body.textContent).toContain('Running in your agent')
    api.getOnboardingSamples.mockResolvedValue({ ...catalog(), session: { active: null,
      completed: { run: { ...active, status: 'passed', endedAt: '2026-01-01T00:01:00Z' } } } })
    await deliver()
    expect(controller.demo.session.active).toBeNull()
    expect(document.querySelector('[data-testid="demo-dialog"]')).toBe(dialog)
    expect(document.body.textContent).toContain('passed')
  })
})
