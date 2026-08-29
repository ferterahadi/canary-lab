// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DurableView, PersistedView } from '../lib/workspace-view-state'
import type { WorkspaceNavigation } from './use-workspace-navigation'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// The URL/localStorage layer is mocked, not the derivation: `nav-state` runs for
// real here (its own suite covers it in isolation) so the seed, the routed
// dialog and the persisted round-trip are proven against the shipped rules.
// Mocking the persistence layer is what makes the SEED controllable at all — the
// hook reads it once at module scope, so each seed needs a fresh module.
const viewState = vi.hoisted(() => ({
  readPersistedView: vi.fn(),
  persistView: vi.fn(),
  onViewChangedInOtherTab: vi.fn(),
}))
vi.mock('../lib/workspace-view-state', () => viewState)

function persisted(over: Partial<PersistedView> = {}): PersistedView {
  return {
    view: 'workspace', feature: null, run: null, dialog: null, flight: null,
    flightStage: null, configTab: null, modelsAgent: null, focusTest: null,
    runTab: null, returnFlight: null,
    ...over,
  }
}

let container: HTMLDivElement
let root: Root
let nav: WorkspaceNavigation
let crossTab: ((state: DurableView) => void) | null
let unsubscribes: number

/** A fresh module per seed: `PERSISTED`/`SEED` are module-scope constants. */
async function mount(seed: PersistedView = persisted()): Promise<void> {
  viewState.readPersistedView.mockReturnValue(seed)
  vi.resetModules()
  const { useWorkspaceNavigation } = await import('./use-workspace-navigation')
  function Probe() {
    nav = useWorkspaceNavigation()
    return null
  }
  await act(async () => { root.render(<Probe />) })
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  crossTab = null
  unsubscribes = 0
  viewState.persistView.mockReset()
  viewState.readPersistedView.mockReset()
  viewState.onViewChangedInOtherTab.mockReset().mockImplementation((cb: (s: DurableView) => void) => {
    crossTab = cb
    return () => { unsubscribes += 1 }
  })
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

describe('useWorkspaceNavigation — seeding from the route', () => {
  it('starts on the persisted view, feature, run and flight', async () => {
    await mount(persisted({ view: 'flights', feature: 'checkout', run: 'r1', flight: 'fl-1', flightStage: 'run' }))

    expect(nav.view).toBe('flights')
    expect(nav.selectedFeature).toBe('checkout')
    expect(nav.selectedRunId).toBe('r1')
    expect(nav.selectedFlightId).toBe('fl-1')
    expect(nav.flightStage).toBe('run')
    // The run mirrors are seeded synchronously so the first WS event can read them.
    expect(nav.selectedRunIdRef.current).toBe('r1')
    expect(nav.pendingRunSelectionRef.current).toBe('r1')
  })

  it('reopens a routed config dialog on its tab', async () => {
    await mount(persisted({ feature: 'checkout', dialog: 'config', configTab: 'ports' }))

    expect(nav.configFor).toBe('checkout')
    expect(nav.configTab).toBe('ports')
    expect(nav.routedDialog).toBe('config')
  })

  it('reopens the other routed dialogs', async () => {
    await mount(persisted({ dialog: 'verification' }))
    expect(nav.verifyOpen).toBe(true)

    await mount(persisted({ feature: 'checkout', dialog: 'flight-fresh' }))
    expect(nav.flightStartFor).toBe('checkout')
    expect(nav.flightStartFresh).toBe(true)

    await mount(persisted({ dialog: 'flight-new' }))
    expect(nav.flightStartNew).toBe(true)

    await mount(persisted({ dialog: 'demo' }))
    expect(nav.demoOpen).toBe(true)
  })

  it('seeds a run arrival intent only alongside its run', async () => {
    await mount(persisted({ run: 'r1', focusTest: 'checkout should pay', runTab: 'changes' }))

    expect(nav.focusTest).toEqual({ runId: 'r1', test: 'checkout should pay' })
    // focusTest wins over the tab, so the seed carries both and the consumer picks.
    expect(nav.runTab).toEqual({ runId: 'r1', tab: 'changes' })
  })
})

describe('useWorkspaceNavigation — dialog openers', () => {
  it('pairs the config tab with the open that set it', async () => {
    await mount()

    await act(async () => { nav.setConfigFor('checkout', 'envsets') })
    expect([nav.configFor, nav.configTab]).toEqual(['checkout', 'envsets'])

    // Omitting the tab resets it, so a later open cannot inherit the last one.
    await act(async () => { nav.setConfigFor('search') })
    expect([nav.configFor, nav.configTab]).toEqual(['search', null])

    await act(async () => { nav.setConfigTab('repos') })
    expect(nav.configTab).toBe('repos')

    await act(async () => { nav.setConfigFor(null, 'ports') })
    expect([nav.configFor, nav.configTab]).toEqual([null, null])
  })

  it('pairs the launcher intent and stage with the open that set them', async () => {
    await mount()

    await act(async () => { nav.setFlightStartFor('checkout', 'fresh') })
    expect([nav.flightStartFor, nav.flightStartFresh, nav.flightStartStage]).toEqual(['checkout', true, null])

    // Default intent is the re-entry picker, and it clears the fresh flag.
    await act(async () => { nav.setFlightStartFor('checkout', undefined, 'run') })
    expect([nav.flightStartFresh, nav.flightStartStage]).toEqual([false, 'run'])

    await act(async () => { nav.setFlightStartFor(null, 'fresh', 'run') })
    expect([nav.flightStartFor, nav.flightStartFresh, nav.flightStartStage]).toEqual([null, false, null])
  })

  it('routes the remaining dialog and target setters', async () => {
    await mount()

    await act(async () => {
      nav.setVerifyOpen(true)
      nav.setFlightStartNew(true)
      nav.setDemoOpen(true)
      nav.setResumePlanTaskId('plan-1')
      nav.setPortifyTarget({ kind: 'new', feature: 'checkout' })
    })

    expect(nav.verifyOpen).toBe(true)
    expect(nav.flightStartNew).toBe(true)
    expect(nav.demoOpen).toBe(true)
    expect(nav.resumePlanTaskId).toBe('plan-1')
    expect(nav.portifyTarget).toEqual({ kind: 'new', feature: 'checkout' })
    // flight-new outranks demo and verify in the z-order.
    expect(nav.routedDialog).toBe('flight-new')
  })

  it('closing settings also drops the stacked model matrix (the setConfigFor rule)', async () => {
    await mount()

    await act(async () => { nav.setSettingsOpen(true) })
    await act(async () => { nav.setModelsFor('codex') })
    expect([nav.settingsOpen, nav.modelsFor]).toEqual([true, 'codex'])

    await act(async () => { nav.setSettingsOpen(false) })
    expect([nav.settingsOpen, nav.modelsFor]).toEqual([false, null])

    // A later open cannot inherit the matrix a previous visit left behind.
    await act(async () => { nav.setSettingsOpen(true) })
    expect(nav.modelsFor).toBeNull()
  })
})

describe('useWorkspaceNavigation — openFlight', () => {
  it('keeps the stage when the same flight is re-opened (a drill-through returning)', async () => {
    await mount(persisted({ view: 'flights', flight: 'fl-1', flightStage: 'run' }))

    await act(async () => { nav.openFlight('fl-1') })

    expect(nav.flightStage).toBe('run')
    expect(nav.view).toBe('flights')
  })

  it('returns to follow-mode when a different flight is opened', async () => {
    await mount(persisted({ view: 'flights', flight: 'fl-1', flightStage: 'run' }))

    await act(async () => { nav.openFlight('fl-2') })

    expect(nav.selectedFlightId).toBe('fl-2')
    expect(nav.flightStage).toBeNull()
  })

  it('clears the way-back origin on arrival', async () => {
    await mount(persisted({ returnFlight: 'fl-9' }))
    expect(nav.returnFlight).toBe('fl-9')

    await act(async () => { nav.openFlight(null) })

    expect(nav.returnFlight).toBeNull()
    expect(nav.selectedFlightId).toBeNull()
  })

  it('sets the stage directly', async () => {
    await mount()

    await act(async () => { nav.setFlightStage('specs-coverage') })

    expect(nav.flightStage).toBe('specs-coverage')
  })
})

describe('useWorkspaceNavigation — run and coverage arrivals', () => {
  it('lands on a named failing test, dropping any tab intent', async () => {
    await mount()

    await act(async () => { nav.navigateToRun('checkout', 'r1', { test: 'should pay', tab: 'changes' }) })

    expect(nav.focusTest).toEqual({ runId: 'r1', test: 'should pay' })
    expect(nav.runTab).toBeNull()
    expect(nav.view).toBe('workspace')
    expect(nav.selectedFeature).toBe('checkout')
  })

  it('lands on a named tab when no test is named', async () => {
    await mount()

    await act(async () => { nav.navigateToRun('checkout', 'r1', { tab: 'changes' }) })

    expect(nav.runTab).toEqual({ runId: 'r1', tab: 'changes' })
    expect(nav.focusTest).toBeNull()
  })

  it('clears a previous arrival intent and origin when neither is named', async () => {
    await mount()
    await act(async () => { nav.navigateToRun('checkout', 'r1', { test: 'should pay' }, 'fl-1') })
    expect(nav.returnFlight).toBe('fl-1')

    await act(async () => { nav.navigateToRun('checkout', 'r2') })

    expect(nav.focusTest).toBeNull()
    expect(nav.runTab).toBeNull()
    expect(nav.returnFlight).toBeNull()
    expect(nav.pendingRunSelectionRef.current).toBeNull()
  })

  it('opens the coverage ledger, carrying the way back only when given one', async () => {
    await mount()

    await act(async () => { nav.navigateToCoverage('checkout', 'fl-1') })
    expect([nav.view, nav.selectedFeature, nav.returnFlight]).toEqual(['coverage', 'checkout', 'fl-1'])

    await act(async () => { nav.navigateToCoverage('search') })
    expect(nav.returnFlight).toBeNull()
  })

  it('seeds the pending guard for a freshly started run', async () => {
    await mount()

    await act(async () => { nav.selectStartedRun('r-new') })

    expect(nav.selectedRunId).toBe('r-new')
    expect(nav.pendingRunSelectionRef.current).toBe('r-new')
  })

  it('mirrors the selection into the refs the WS handler reads', async () => {
    await mount()

    await act(async () => {
      nav.setSelectedFeature('checkout')
      nav.setSelectedRunId('r5')
      nav.setSelectedFlightId('fl-5')
      nav.setView('cleanup')
    })

    expect(nav.selectedFeatureRef.current).toBe('checkout')
    expect(nav.selectedRunIdRef.current).toBe('r5')
    expect(nav.view).toBe('cleanup')
  })
})

describe('useWorkspaceNavigation — persistence and cross-tab sync', () => {
  it('writes the whole route out on every change', async () => {
    await mount()
    viewState.persistView.mockClear()

    await act(async () => { nav.navigateToCoverage('checkout', 'fl-1') })

    expect(viewState.persistView).toHaveBeenCalledWith(
      expect.objectContaining({ view: 'coverage', feature: 'checkout', returnFlight: 'fl-1' }),
    )
  })

  it('follows another tab\'s view change, and its feature when it names one', async () => {
    await mount()

    await act(async () => { crossTab?.({ view: 'cleanup', feature: 'checkout' }) })
    expect([nav.view, nav.selectedFeature]).toEqual(['cleanup', 'checkout'])

    // A durable push with no feature must not blank the current selection.
    await act(async () => { crossTab?.({ view: 'flights', feature: null }) })
    expect([nav.view, nav.selectedFeature]).toEqual(['flights', 'checkout'])
  })

  it('unsubscribes from the cross-tab channel on unmount', async () => {
    await mount()

    act(() => { root.unmount() })

    expect(unsubscribes).toBe(1)
  })
})
