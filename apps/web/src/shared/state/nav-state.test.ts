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
  demoOpen: false,
  settingsOpen: false,
  modelsFor: null,
  resumePlanTaskId: null,
  portifyTarget: null,
  focusTest: null,
  runTab: null,
  returnFlight: null,
}

const persisted = (over: Partial<PersistedView> = {}): PersistedView => ({
  view: 'workspace',
  feature: null,
  run: null,
  dialog: null,
  flight: null,
  flightStage: null,
  configTab: null,
  modelsAgent: null,
  focusTest: null,
  runTab: null,
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
    expect(initialNavState(persisted({ dialog: 'verification', configTab: 'ports' })).configTab).toBeNull()
  })

  it('stacks the model matrix over settings only when settings itself is routed', () => {
    const s = initialNavState(persisted({ dialog: 'settings', modelsAgent: 'codex' }))
    expect([s.settingsOpen, s.modelsFor]).toEqual([true, 'codex'])
    expect(navToPersistedView(s).modelsAgent).toBe('codex')
    // A matrix qualifier that outlived its dialog is dropped, same as configTab.
    expect(initialNavState(persisted({ dialog: 'demo', modelsAgent: 'codex' })).modelsFor).toBeNull()
    // And the write side drops it once settings is closed.
    expect(navToPersistedView({ ...s, settingsOpen: false }).modelsAgent).toBeNull()
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

  it('reopens the demo chooser from a cold load, and only from its own param', () => {
    expect(initialNavState(persisted({ dialog: 'demo' })).demoOpen).toBe(true)
    expect(initialNavState(persisted({ dialog: 'config' })).demoOpen).toBe(false)
  })

  it('reopens Project Settings from a cold load, and only from its own param', () => {
    expect(initialNavState(persisted({ dialog: 'settings' })).settingsOpen).toBe(true)
    expect(initialNavState(persisted({ dialog: 'config' })).settingsOpen).toBe(false)
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

// The arrival tab follows the focused test's pairing rule exactly — it is the
// same kind of fact (where in THIS run to land), so it can't be allowed to leak
// onto the next run the user opens.
describe('run arrival tab', () => {
  it('pairs the persisted tab with the persisted run', () => {
    const s = initialNavState(persisted({ feature: 'checkout', run: 'run-1', runTab: 'changes' }))
    expect(s.runTab).toEqual({ runId: 'run-1', tab: 'changes' })
  })

  it('drops a tab that arrived without a run', () => {
    expect(initialNavState(persisted({ feature: 'checkout', runTab: 'changes' })).runTab).toBeNull()
  })

  it('serializes only a tab belonging to the CURRENT run', () => {
    const mine: NavState = { ...base, run: 'run-1', runTab: { runId: 'run-1', tab: 'changes' } }
    expect(navToPersistedView(mine).runTab).toBe('changes')
    const stale: NavState = { ...base, run: 'run-2', runTab: { runId: 'run-1', tab: 'changes' } }
    expect(navToPersistedView(stale).runTab).toBeNull()
  })
})

describe('routedDialog precedence (z-order)', () => {
  it('is null with nothing open', () => {
    expect(routedDialog(base)).toBeNull()
  })

  it('config outranks flight-start, flight-new and verify', () => {
    expect(routedDialog({ ...base, configFor: 'x', flightStartFor: 'y', flightStartNew: true, verifyOpen: true })).toBe('config')
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

  it('routes the demo chooser', () => {
    expect(routedDialog({ ...base, demoOpen: true })).toBe('demo')
  })

  it('lets the flight launcher the chooser opened outrank the chooser itself', () => {
    // "Start a flight" leaves both open for a tick; the URL must name the
    // launcher, which is what the user is actually looking at.
    expect(routedDialog({ ...base, demoOpen: true, flightStartNew: true })).toBe('flight-new')
  })

  it('demo outranks verify', () => {
    expect(routedDialog({ ...base, demoOpen: true, verifyOpen: true })).toBe('demo')
  })

  it('verify wins when it is the only one open', () => {
    expect(routedDialog({ ...base, verifyOpen: true })).toBe('verification')
  })

  it('routes Project Settings, and ranks it under every overlay above it', () => {
    expect(routedDialog({ ...base, settingsOpen: true })).toBe('settings')
    // It mounts in the features column — the first column App renders — so
    // anything else open is painting over it and owns the URL.
    expect(routedDialog({ ...base, settingsOpen: true, verifyOpen: true })).toBe('verification')
    expect(routedDialog({ ...base, settingsOpen: true, configFor: 'x' })).toBe('config')
  })
})

describe('navToPersistedView', () => {
  it('projects the routable fields + the winning dialog', () => {
    const s: NavState = { ...base, view: 'flights', feature: 'checkout', run: 'run-1', flight: 'fl_1', configFor: 'checkout', configTab: 'ports' }
    expect(navToPersistedView(s)).toEqual({ view: 'flights', feature: 'checkout', run: 'run-1', dialog: 'config', flight: 'fl_1', flightStage: null, configTab: 'ports', modelsAgent: null, focusTest: null, runTab: null, returnFlight: null })
  })
})

describe('resolveActivityTarget', () => {
  const flights = [{ flightId: 'fl_1', feature: 'checkout' }] as unknown as FlightIndexEntry[]

  it('running → the feature flight, pinned to its Test Run stage', () => {
    expect(resolveActivityTarget('checkout', { kind: 'running', runId: 'run-9' }, flights))
      .toEqual({ kind: 'flight', flightId: 'fl_1', stage: 'run' })
  })

  it('running on a never-flown feature → the DERIVED flight, still pinned to the run', () => {
    // The bug this replaced: the same feature routed to the flight view when
    // idle and to the bare run detail while a run was live, so the destination
    // was decided by timing rather than by what the user clicked.
    expect(resolveActivityTarget('other', { kind: 'running', runId: 'run-9' }, flights))
      .toEqual({ kind: 'flight', flightId: 'feature:other', stage: 'run' })
  })

  it('running with no runId → still the flight, pinned to the run stage', () => {
    expect(resolveActivityTarget('checkout', { kind: 'running' }, flights))
      .toEqual({ kind: 'flight', flightId: 'fl_1', stage: 'run' })
  })

  it('exporting → the feature flight when one exists, pinned to the export stage', () => {
    expect(resolveActivityTarget('checkout', { kind: 'exporting', runId: 'run-9' }, flights))
      .toEqual({ kind: 'flight', flightId: 'fl_1', stage: 'evaluation-export' })
  })

  it('exporting with no flight → the DERIVED flight, never the landing list', () => {
    // The bug this replaced: an export on a flightless feature resolved to
    // `flightId: null`, so the row the user clicked to watch the export land
    // reopened the flights list instead of the flight page.
    expect(resolveActivityTarget('other', { kind: 'exporting' }, flights))
      .toEqual({ kind: 'flight', flightId: 'feature:other', stage: 'evaluation-export' })
  })

  it('portifying → the portify workflow', () => {
    expect(resolveActivityTarget('checkout', { kind: 'portifying', workflowId: 'wf_1' }, flights))
      .toEqual({ kind: 'portify', workflowId: 'wf_1' })
  })

  it('authoring → the flight at its specs stage (the routed draft dialog is retired)', () => {
    // draftId or not, monitoring happens where every other agent job does:
    // the FlightPage's specs-coverage stage renders the external draft card.
    expect(resolveActivityTarget('checkout', { kind: 'authoring', draftId: 'dr_9' }, flights))
      .toEqual({ kind: 'flight', flightId: 'fl_1', stage: 'specs-coverage' })
    expect(resolveActivityTarget('checkout', { kind: 'authoring' }, flights))
      .toEqual({ kind: 'flight', flightId: 'fl_1', stage: 'specs-coverage' })
  })

  it('EXTERNAL portifying → the flight at its portify stage, not the embedded view', () => {
    // The agent runs in the user's own client; the embedded workflow view's
    // controls have nothing to drive, so it monitors like everything else.
    expect(resolveActivityTarget('checkout', { kind: 'portifying', workflowId: 'wf_1', external: true }, flights))
      .toEqual({ kind: 'flight', flightId: 'fl_1', stage: 'portify' })
  })

  it('portifying with no workflowId → the flight at its portify stage', () => {
    expect(resolveActivityTarget('other', { kind: 'portifying' }, flights))
      .toEqual({ kind: 'flight', flightId: 'feature:other', stage: 'portify' })
  })
})
