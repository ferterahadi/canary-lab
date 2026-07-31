import { describe, expect, it } from 'vitest'
import {
  initialNavState,
  navToPersistedView,
  resolveActivityTarget,
  routedDialog,
  type NavState,
} from './nav-state'
import type { PersistedView } from '../lib/workspace-view-state'
import type { FlightIndexEntry } from '../api/client'

const base: NavState = {
  view: 'workspace',
  feature: null,
  run: null,
  flight: null,
  flightStage: null,
  configFor: null,
  configTab: null,
  verifyOpen: false,
  flightStartFor: null,
  flightStartFresh: false,
  flightStartNew: false,
  draftFor: null,
  resumePlanTaskId: null,
  portifyTarget: null,
  focusTest: null,
  returnFlight: null,
}

const persisted = (over: Partial<PersistedView> = {}): PersistedView => ({
  view: 'workspace',
  feature: null,
  run: null,
  dialog: null,
  flight: null,
  flightStage: null,
  draft: null,
  configTab: null,
  focusTest: null,
  returnFlight: null,
  ...over,
})

describe('initialNavState', () => {
  it('carries view/feature/run/flight straight through', () => {
    const s = initialNavState(persisted({ view: 'coverage', feature: 'checkout', run: 'run-1', flight: 'fl_1' }))
    expect(s).toMatchObject({ view: 'coverage', feature: 'checkout', run: 'run-1', flight: 'fl_1' })
  })

  // R83: a refresh on a drilled-into view must keep the way back to the flight.
  it('hydrates the origin flight so a refreshed destination keeps its way back', () => {
    const s = initialNavState(persisted({ view: 'coverage', feature: 'checkout', returnFlight: 'fl_1' }))
    expect(s.returnFlight).toBe('fl_1')
    expect(navToPersistedView(s).returnFlight).toBe('fl_1')
  })

  it('hydrates the selected stage, and only alongside a flight', () => {
    const s = initialNavState(persisted({ view: 'flights', flight: 'fl_1', flightStage: 'specs-coverage' }))
    expect(s.flightStage).toBe('specs-coverage')
    expect(navToPersistedView(s).flightStage).toBe('specs-coverage')
    // No flight to hang it on → follow-mode.
    expect(initialNavState(persisted({ view: 'flights', flightStage: 'specs-coverage' })).flightStage).toBeNull()
    // A stale or hand-typed stage name reads as follow-mode, never a blank pane.
    expect(initialNavState(persisted({ view: 'flights', flight: 'fl_1', flightStage: 'not-a-stage' })).flightStage).toBeNull()
  })

  it('opens the config dialog on the persisted feature + tab', () => {
    const s = initialNavState(persisted({ dialog: 'config', feature: 'checkout', configTab: 'ports' }))
    expect(s.configTab).toBe('ports')
    // A tab that outlived its dialog is dropped, not carried onto another one.
    expect(initialNavState(persisted({ dialog: 'draft', configTab: 'ports' })).configTab).toBeNull()
  })

  it('opens the config dialog on the persisted feature', () => {
    const s = initialNavState(persisted({ dialog: 'config', feature: 'checkout' }))
    expect(s.configFor).toBe('checkout')
    expect(s.verifyOpen).toBe(false)
  })

  it('opens the flight-start dialog on the persisted feature', () => {
    const s = initialNavState(persisted({ dialog: 'flight-start', feature: 'checkout' }))
    expect(s.flightStartFor).toBe('checkout')
  })

  it('opens the launcher in fresh intent from ?dialog=flight-fresh (R76)', () => {
    const s = initialNavState(persisted({ dialog: 'flight-fresh', feature: 'checkout' }))
    expect(s.flightStartFor).toBe('checkout')
    expect(s.flightStartFresh).toBe(true)
  })

  it('leaves the fresh flag off for a plain flight-start', () => {
    expect(initialNavState(persisted({ dialog: 'flight-start', feature: 'checkout' })).flightStartFresh).toBe(false)
  })

  it('opens verification / flight-new from their dialog params', () => {
    expect(initialNavState(persisted({ dialog: 'verification' })).verifyOpen).toBe(true)
    expect(initialNavState(persisted({ dialog: 'flight-new' })).flightStartNew).toBe(true)
  })

  it('opens the draft dialog on the persisted draft id', () => {
    expect(initialNavState(persisted({ dialog: 'draft', draft: 'dr_9' })).draftFor).toBe('dr_9')
  })
})

// R82: the focused test is stored as a PAIR with its run, so a focus can never
// apply to a run it did not come from — no clearing effect to keep in sync.
describe('focused test (R82)', () => {
  it('pairs the persisted test with the persisted run', () => {
    const s = initialNavState(persisted({ feature: 'checkout', run: 'run-1', focusTest: 'test-case-otp' }))
    expect(s.focusTest).toEqual({ runId: 'run-1', test: 'test-case-otp' })
  })

  it('drops a test that arrived without a run', () => {
    expect(initialNavState(persisted({ feature: 'checkout', focusTest: 'test-case-otp' })).focusTest).toBeNull()
  })

  it('serializes only a focus belonging to the CURRENT run', () => {
    const mine: NavState = { ...base, run: 'run-1', focusTest: { runId: 'run-1', test: 'test-case-otp' } }
    expect(navToPersistedView(mine).focusTest).toBe('test-case-otp')
    // Selecting another run makes the stale pair inert rather than pinning it.
    const stale: NavState = { ...base, run: 'run-2', focusTest: { runId: 'run-1', test: 'test-case-otp' } }
    expect(navToPersistedView(stale).focusTest).toBeNull()
  })
})

describe('routedDialog precedence (z-order)', () => {
  it('is null with nothing open', () => {
    expect(routedDialog(base)).toBeNull()
  })

  it('config outranks draft, flight-start, flight-new and verify', () => {
    expect(routedDialog({ ...base, configFor: 'x', draftFor: 'dr_9', flightStartFor: 'y', flightStartNew: true, verifyOpen: true })).toBe('config')
  })

  it('draft outranks flight-start, flight-new and verify', () => {
    expect(routedDialog({ ...base, draftFor: 'dr_9', flightStartFor: 'y', flightStartNew: true, verifyOpen: true })).toBe('draft')
  })

  it('flight-start outranks flight-new and verify', () => {
    expect(routedDialog({ ...base, flightStartFor: 'y', flightStartNew: true, verifyOpen: true })).toBe('flight-start')
  })

  it('routes the fresh intent to its own dialog value (R76)', () => {
    expect(routedDialog({ ...base, flightStartFor: 'y', flightStartFresh: true })).toBe('flight-fresh')
    // The flag alone routes nothing — it qualifies an open launcher.
    expect(routedDialog({ ...base, flightStartFresh: true })).toBeNull()
  })

  it('flight-new outranks verify', () => {
    expect(routedDialog({ ...base, flightStartNew: true, verifyOpen: true })).toBe('flight-new')
  })

  it('verify wins when it is the only one open', () => {
    expect(routedDialog({ ...base, verifyOpen: true })).toBe('verification')
  })
})

describe('navToPersistedView', () => {
  it('projects the routable fields + the winning dialog', () => {
    const s: NavState = { ...base, view: 'flights', feature: 'checkout', run: 'run-1', flight: 'fl_1', configFor: 'checkout', configTab: 'ports' }
    expect(navToPersistedView(s)).toEqual({ view: 'flights', feature: 'checkout', run: 'run-1', dialog: 'config', flight: 'fl_1', flightStage: null, draft: null, configTab: 'ports', focusTest: null, returnFlight: null })
  })

  it('projects the open draft id + dialog=draft', () => {
    const s: NavState = { ...base, draftFor: 'dr_9' }
    expect(navToPersistedView(s)).toEqual({ view: 'workspace', feature: null, run: null, dialog: 'draft', flight: null, flightStage: null, draft: 'dr_9', configTab: null, focusTest: null, returnFlight: null })
  })
})

describe('resolveActivityTarget', () => {
  const flights = [{ flightId: 'fl_1', feature: 'checkout' }] as unknown as FlightIndexEntry[]

  it('running → open that run in the workspace', () => {
    expect(resolveActivityTarget('checkout', { kind: 'running', runId: 'run-9' }, flights))
      .toEqual({ kind: 'run', feature: 'checkout', runId: 'run-9' })
  })

  it('running with no runId → no target', () => {
    expect(resolveActivityTarget('checkout', { kind: 'running' }, flights)).toBeNull()
  })

  it('exporting → the feature flight when one exists', () => {
    expect(resolveActivityTarget('checkout', { kind: 'exporting', runId: 'run-9' }, flights))
      .toEqual({ kind: 'flight', flightId: 'fl_1' })
  })

  it('exporting with no flight → the flights landing (null flight)', () => {
    expect(resolveActivityTarget('other', { kind: 'exporting' }, flights))
      .toEqual({ kind: 'flight', flightId: null })
  })

  it('portifying → the portify workflow', () => {
    expect(resolveActivityTarget('checkout', { kind: 'portifying', workflowId: 'wf_1' }, flights))
      .toEqual({ kind: 'portify', workflowId: 'wf_1' })
  })

  it('authoring → the draft dialog for its draftId', () => {
    expect(resolveActivityTarget('checkout', { kind: 'authoring', draftId: 'dr_9' }, flights))
      .toEqual({ kind: 'draft', draftId: 'dr_9' })
  })

  it('authoring with no draftId → no target', () => {
    expect(resolveActivityTarget('checkout', { kind: 'authoring' }, flights)).toBeNull()
  })
})
