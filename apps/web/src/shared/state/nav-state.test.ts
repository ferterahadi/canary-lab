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
  configFor: null,
  verifyOpen: false,
  flightStartFor: null,
  flightStartNew: false,
  draftFor: null,
  resumePlanTaskId: null,
  portifyTarget: null,
}

const persisted = (over: Partial<PersistedView> = {}): PersistedView => ({
  view: 'workspace',
  feature: null,
  run: null,
  dialog: null,
  flight: null,
  draft: null,
  ...over,
})

describe('initialNavState', () => {
  it('carries view/feature/run/flight straight through', () => {
    const s = initialNavState(persisted({ view: 'coverage', feature: 'checkout', run: 'run-1', flight: 'fl_1' }))
    expect(s).toMatchObject({ view: 'coverage', feature: 'checkout', run: 'run-1', flight: 'fl_1' })
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

  it('opens verification / flight-new from their dialog params', () => {
    expect(initialNavState(persisted({ dialog: 'verification' })).verifyOpen).toBe(true)
    expect(initialNavState(persisted({ dialog: 'flight-new' })).flightStartNew).toBe(true)
  })

  it('opens the draft dialog on the persisted draft id', () => {
    expect(initialNavState(persisted({ dialog: 'draft', draft: 'dr_9' })).draftFor).toBe('dr_9')
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

  it('flight-new outranks verify', () => {
    expect(routedDialog({ ...base, flightStartNew: true, verifyOpen: true })).toBe('flight-new')
  })

  it('verify wins when it is the only one open', () => {
    expect(routedDialog({ ...base, verifyOpen: true })).toBe('verification')
  })
})

describe('navToPersistedView', () => {
  it('projects the routable fields + the winning dialog', () => {
    const s: NavState = { ...base, view: 'flights', feature: 'checkout', run: 'run-1', flight: 'fl_1', configFor: 'checkout' }
    expect(navToPersistedView(s)).toEqual({ view: 'flights', feature: 'checkout', run: 'run-1', dialog: 'config', flight: 'fl_1', draft: null })
  })

  it('projects the open draft id + dialog=draft', () => {
    const s: NavState = { ...base, draftFor: 'dr_9' }
    expect(navToPersistedView(s)).toEqual({ view: 'workspace', feature: null, run: null, dialog: 'draft', flight: null, draft: 'dr_9' })
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
