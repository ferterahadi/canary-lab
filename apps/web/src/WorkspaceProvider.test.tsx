import { act } from 'react'
import type { Root } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FlightIndexEntry } from '@shared/flights/types'
import { mountRoot } from '@/test-helpers/mount-root'
import { useWorkState, type WorkState } from './shared/state/work-state'
import { useWorkspaceActions, type WorkspaceActions } from './shared/state/workspace-actions'
import { WorkspaceProvider, useWorkspace, type Workspace } from './WorkspaceProvider'

// The four workspace hooks have their own suites; this one pins the wiring
// between them — which value feeds which hook, and what every action the
// provider builds does to navigation — plus the two narrow contexts it fills.
const hooks = vi.hoisted(() => ({
  nav: {} as Record<string, unknown>,
  selection: {} as Record<string, unknown>,
  data: {} as Record<string, unknown>,
  work: {} as Record<string, unknown>,
  runs: [] as unknown[],
  invalidate: (() => {}) as (topic: string) => void,
  selectionInput: undefined as unknown,
  dataInput: undefined as unknown,
  workInput: undefined as unknown,
}))

vi.mock('./shared/state/use-workspace-navigation', () => ({ useWorkspaceNavigation: () => hooks.nav }))
vi.mock('./shared/state/use-workspace-selection', () => ({
  useWorkspaceSelection: (input: unknown) => { hooks.selectionInput = input; return hooks.selection },
}))
vi.mock('./shared/state/use-workspace-data', () => ({
  useWorkspaceData: (input: unknown) => { hooks.dataInput = input; return hooks.data },
}))
vi.mock('./features/flights/state/use-workspace-flights', () => ({
  useWorkspaceFlights: (input: unknown) => { hooks.workInput = input; return hooks.work },
}))
vi.mock('./features/runs/state/RunsContext', () => ({ useRuns: () => ({ runs: hooks.runs }) }))
vi.mock('./shared/state/invalidation', () => ({ useInvalidation: () => ({ invalidate: hooks.invalidate }) }))

let root: Root
mountRoot({ attach: true, onMount: (mounted) => ({ root } = mounted) })

const flights = [{ flightId: 'fl_1', feature: 'checkout' }] as unknown as FlightIndexEntry[]
let seen: { workspace: Workspace; actions: WorkspaceActions; workState: WorkState }

function Probe() {
  seen = { workspace: useWorkspace(), actions: useWorkspaceActions(), workState: useWorkState() }
  return null
}

beforeEach(() => {
  hooks.nav = {
    selectedFeature: 'checkout', selectedRunId: 'run-1', configFor: 'checkout', configTab: 'ports',
    pendingRunSelectionRef: { current: null }, selectedFeatureRef: { current: 'checkout' }, selectedRunIdRef: { current: 'run-1' },
    setSelectedFeature: vi.fn(), setSelectedRunId: vi.fn(), setConfigFor: vi.fn(), openFlight: vi.fn(),
    setFlightStage: vi.fn(), setFlightStartFor: vi.fn(), setFlightStartNew: vi.fn(), setResumePlanTaskId: vi.fn(),
    navigateToRun: vi.fn(), openReview: vi.fn(),
  }
  hooks.selection = { onInitialFeatures: vi.fn(), onFeaturesRefreshed: vi.fn() }
  hooks.data = {
    features: [{ name: 'checkout' }], flights, preFlights: [], refreshFeatures: vi.fn(), flightsRef: { current: flights },
  }
  hooks.work = {
    activity: new Map(), externalHistory: new Map(), coverageJobs: [], portifyWorkflows: [],
    derivedStages: new Map(), pickerFeatures: [{ name: 'checkout' }],
  }
  hooks.runs = [{ runId: 'run-1' }]
  hooks.invalidate = vi.fn()
})

async function mount() {
  await act(async () => root.render(<WorkspaceProvider><Probe /></WorkspaceProvider>))
  return seen
}

const nav = (name: string) => hooks.nav[name] as ReturnType<typeof vi.fn>

describe('WorkspaceProvider', () => {
  it('feeds each hook the values the one before it produced', async () => {
    await mount()
    expect(hooks.selectionInput).toMatchObject({
      allRuns: hooks.runs, selectedFeature: 'checkout', selectedRunId: 'run-1',
      setSelectedFeature: hooks.nav.setSelectedFeature, setSelectedRunId: hooks.nav.setSelectedRunId,
      selectedFeatureRef: hooks.nav.selectedFeatureRef, selectedRunIdRef: hooks.nav.selectedRunIdRef,
      pendingRunSelectionRef: hooks.nav.pendingRunSelectionRef,
    })
    expect(hooks.dataInput).toMatchObject({
      invalidate: hooks.invalidate,
      onInitialFeatures: hooks.selection.onInitialFeatures,
      onFeaturesRefreshed: hooks.selection.onFeaturesRefreshed,
      selectedFeatureRef: hooks.nav.selectedFeatureRef,
      selectedRunIdRef: hooks.nav.selectedRunIdRef,
    })
    expect(hooks.workInput).toMatchObject({
      features: hooks.data.features, flights, selectedFeature: 'checkout', refreshFeatures: hooks.data.refreshFeatures,
    })
  })

  it('invalidates coverage through the shared bus', async () => {
    const { workspace } = await mount()
    workspace.invalidateCoverage()
    expect(hooks.invalidate).toHaveBeenCalledWith('coverage')
    expect((hooks.workInput as { invalidateCoverage: unknown }).invalidateCoverage).toBe(workspace.invalidateCoverage)
  })

  it('moves the open config dialog with a renamed suite, and only that one', async () => {
    await mount()
    const { onFeatureRenamed } = hooks.dataInput as { onFeatureRenamed: (from: string, to: string) => void }
    onFeatureRenamed('billing', 'invoices')
    expect(nav('setConfigFor')).not.toHaveBeenCalled()
    onFeatureRenamed('checkout', 'cart')
    expect(nav('setConfigFor')).toHaveBeenCalledWith('cart', 'ports')
  })

  it('opens a flight stage by its rail row', async () => {
    const { workspace } = await mount()
    workspace.openFlightStage('fl_1', 'prd-summary')
    expect(nav('openFlight')).toHaveBeenCalledWith('fl_1')
    // The rail folds the summary distiller into its Requirements row.
    expect(nav('setFlightStage')).toHaveBeenCalledWith('docs')
  })

  it('opens a suite stage on its recorded flight, or its derived one', async () => {
    const { workspace } = await mount()
    workspace.openFeatureStage('checkout', 'run')
    expect(nav('setSelectedFeature')).toHaveBeenCalledWith('checkout')
    expect(nav('openFlight')).toHaveBeenLastCalledWith('fl_1')
    workspace.openFeatureStage('billing', 'run')
    expect(nav('openFlight')).toHaveBeenLastCalledWith('feature:billing')
  })

  it('opens Parallel setup after closing the config dialog', async () => {
    const { actions } = await mount()
    actions.openPortifyStage!('checkout')
    expect(nav('setConfigFor')).toHaveBeenCalledWith(null)
    expect(nav('openFlight')).toHaveBeenCalledWith('fl_1')
    expect(nav('setFlightStage')).toHaveBeenCalledWith('portify')
  })

  it('opens an activity on the stage that owns it', async () => {
    const { actions } = await mount()
    actions.openActivity!('checkout', { kind: 'running', runId: 'run-9' })
    expect(nav('openFlight')).toHaveBeenCalledWith('fl_1')
    expect(nav('setFlightStage')).toHaveBeenCalledWith('run')
  })

  it('opens a picked flight on a stage when one is named, else bare', async () => {
    const { actions } = await mount()
    actions.openFlight!('fl_1', 'portify')
    expect(nav('setFlightStage')).toHaveBeenCalledWith('portify')
    actions.openFlight!(null)
    expect(nav('openFlight')).toHaveBeenLastCalledWith(null)
    expect(nav('setFlightStage')).toHaveBeenCalledTimes(1)
  })

  it('reopens a pre-flight in the new-flight dialog', async () => {
    const { actions } = await mount()
    actions.openPreFlight!('task-7')
    expect(nav('setResumePlanTaskId')).toHaveBeenCalledWith('task-7')
    expect(nav('setFlightStartNew')).toHaveBeenCalledWith(true)
  })

  it('selects the suite before opening its launcher', async () => {
    const { actions } = await mount()
    actions.startFlight!('billing', 'fresh', 'run')
    expect(nav('setSelectedFeature')).toHaveBeenCalledWith('billing')
    expect(nav('setFlightStartFor')).toHaveBeenCalledWith('billing', 'fresh', 'run')
  })

  it('hands the navigation callbacks and the live work to the narrow contexts', async () => {
    const { actions, workState } = await mount()
    expect(actions.navigateToRun).toBe(hooks.nav.navigateToRun)
    expect(actions.openReview).toBe(hooks.nav.openReview)
    expect(workState).toEqual({
      flights, preFlights: hooks.data.preFlights, activity: hooks.work.activity,
      externalHistory: hooks.work.externalHistory, coverageJobs: hooks.work.coverageJobs,
      portifyWorkflows: hooks.work.portifyWorkflows, derivedStages: hooks.work.derivedStages,
      pickerFeatures: hooks.work.pickerFeatures,
    })
  })

  it('refuses to lay out a workspace without its provider', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(act(async () => root.render(<Probe />))).rejects.toThrow('useWorkspace must be used inside WorkspaceProvider')
    error.mockRestore()
  })
})
