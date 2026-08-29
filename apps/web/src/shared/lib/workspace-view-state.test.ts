// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readPersistedView, persistView, onViewChangedInOtherTab, type PersistedView } from './workspace-view-state'

const KEY = 'cl.workspace.view'

/** Build a full PersistedView with sensible defaults for the fields under test. */
function view(partial: Partial<PersistedView>): PersistedView {
  return { view: 'workspace', feature: null, run: null, dialog: null, flight: null, flightStage: null, configTab: null, modelsAgent: null, focusTest: null, runTab: null, returnFlight: null, ...partial }
}

beforeEach(() => {
  localStorage.clear()
  window.history.replaceState(null, '', '/')
})
afterEach(() => {
  localStorage.clear()
  window.history.replaceState(null, '', '/')
})

describe('workspace-view-state (R12)', () => {
  it('defaults to the workspace view with no feature', () => {
    expect(readPersistedView()).toEqual(view({}))
  })

  it('round-trips through the URL on persist (survives refresh)', () => {
    persistView(view({ view: 'coverage', feature: 'checkout' }))
    expect(window.location.search).toContain('view=coverage')
    expect(window.location.search).toContain('feature=checkout')
    // A fresh read (as on refresh) recovers the same state from the URL.
    expect(readPersistedView()).toEqual(view({ view: 'coverage', feature: 'checkout' }))
  })

  // R82: `test` names WHICH failing test the run detail lands on. It qualifies a
  // selected run, so it round-trips with one and is dropped without one.
  it('round-trips the focused test alongside its run', () => {
    persistView(view({ feature: 'checkout', run: '7cvh', focusTest: 'test-case-req-r4-otp-guard' }))
    expect(window.location.search).toContain('run=7cvh')
    expect(window.location.search).toContain('test=test-case-req-r4-otp-guard')
    expect(readPersistedView()).toEqual(view({ feature: 'checkout', run: '7cvh', focusTest: 'test-case-req-r4-otp-guard' }))
  })

  it('drops the focused test when no run is selected', () => {
    persistView(view({ feature: 'checkout', focusTest: 'test-case-req-r4-otp-guard' }))
    expect(window.location.search).not.toContain('test=')
    expect(readPersistedView().focusTest).toBeNull()
  })

  it('ignores a stray test param on a URL with no run', () => {
    window.history.replaceState(null, '', '/?feature=checkout&test=test-case-orphan')
    expect(readPersistedView().focusTest).toBeNull()
  })

  // `runtab` names WHICH pane a drill-through wanted (the flight run stage's
  // captured-fixes link → Changes). Same qualifier rules as `test`.
  it('round-trips the arrival tab alongside its run', () => {
    persistView(view({ feature: 'checkout', run: '7cvh', runTab: 'changes' }))
    expect(window.location.search).toContain('runtab=changes')
    expect(readPersistedView()).toEqual(view({ feature: 'checkout', run: '7cvh', runTab: 'changes' }))
  })

  it('drops the arrival tab when no run is selected', () => {
    persistView(view({ feature: 'checkout', runTab: 'changes' }))
    expect(window.location.search).not.toContain('runtab=')
    expect(readPersistedView().runTab).toBeNull()
  })

  it('ignores an unknown runtab value rather than opening a pane that has none', () => {
    window.history.replaceState(null, '', '/?feature=checkout&run=7cvh&runtab=nonsense')
    expect(readPersistedView().runTab).toBeNull()
  })

  // R83: `from` names the flight a stage drill-through left, so the destination
  // (coverage ledger / run detail) can offer a way back that survives a refresh.
  it('round-trips the origin flight on a drilled-into view', () => {
    persistView(view({ view: 'coverage', feature: 'checkout', returnFlight: 'fl_abc' }))
    expect(window.location.search).toContain('from=fl_abc')
    expect(readPersistedView()).toEqual(view({ view: 'coverage', feature: 'checkout', returnFlight: 'fl_abc' }))
  })

  it('round-trips a derived-flight origin token', () => {
    persistView(view({ feature: 'checkout', run: '7cvh', returnFlight: 'feature:checkout' }))
    expect(readPersistedView().returnFlight).toBe('feature:checkout')
  })

  it('drops the origin flight on the flights view — you are already there', () => {
    persistView(view({ view: 'flights', flight: 'fl_abc', returnFlight: 'fl_abc' }))
    expect(window.location.search).not.toContain('from=')
    expect(readPersistedView().returnFlight).toBeNull()
  })

  it('ignores a stray from param on the flights view', () => {
    window.history.replaceState(null, '', '/?view=flights&flight=fl_abc&from=fl_old')
    expect(readPersistedView().returnFlight).toBeNull()
  })

  it('treats a lone from param as an authoritative URL (workspace + origin)', () => {
    window.history.replaceState(null, '', '/?from=fl_abc')
    expect(readPersistedView()).toEqual(view({ returnFlight: 'fl_abc' }))
  })

  it('reads an empty from param as no origin', () => {
    window.history.replaceState(null, '', '/?feature=checkout&from=')
    expect(readPersistedView().returnFlight).toBeNull()
  })

  it('keeps the origin flight OUT of localStorage (URL-only tier)', () => {
    persistView(view({ view: 'coverage', feature: 'checkout', returnFlight: 'fl_abc' }))
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({ view: 'coverage', feature: 'checkout' })
  })

  it('keeps the focused test OUT of localStorage (URL-only tier)', () => {
    persistView(view({ feature: 'checkout', run: '7cvh', focusTest: 'test-case-req-r4-otp-guard' }))
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({ view: 'workspace', feature: 'checkout' })
  })

  it('mirrors the durable tier to localStorage so other tabs can read it', () => {
    persistView(view({ view: 'coverage', feature: 'checkout' }))
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({ view: 'coverage', feature: 'checkout' })
  })

  it('URL takes precedence over localStorage', () => {
    localStorage.setItem(KEY, JSON.stringify({ view: 'cleanup', feature: null }))
    window.history.replaceState(null, '', '/?view=coverage&feature=pat')
    expect(readPersistedView()).toEqual(view({ view: 'coverage', feature: 'pat' }))
  })

  it('falls back to localStorage when the URL has no view', () => {
    localStorage.setItem(KEY, JSON.stringify({ view: 'coverage', feature: 'pat' }))
    expect(readPersistedView()).toEqual(view({ view: 'coverage', feature: 'pat' }))
  })

  it('clears the query params when returning to the workspace', () => {
    persistView(view({ view: 'coverage', feature: 'checkout' }))
    persistView(view({ view: 'workspace', feature: 'checkout' }))
    expect(window.location.search).not.toContain('view=')
  })

  it('notifies on a cross-tab storage change', () => {
    const seen: Array<{ view: string; feature: string | null }> = []
    const off = onViewChangedInOtherTab((s) => seen.push(s))
    window.dispatchEvent(new StorageEvent('storage', {
      key: KEY,
      newValue: JSON.stringify({ view: 'coverage', feature: 'checkout' }),
    }))
    expect(seen).toEqual([{ view: 'coverage', feature: 'checkout' }])
    off()
  })

  it('deletes the feature param when feature is null (line 49 false branch)', () => {
    // Set a feature first, then persist without one — verifies the `else params.delete('feature')` path.
    window.history.replaceState(null, '', '/?view=coverage&feature=checkout')
    persistView(view({ view: 'coverage', feature: null }))
    expect(window.location.search).not.toContain('feature=')
    expect(window.location.search).toContain('view=coverage')
  })

  it('ignores unrelated storage keys', () => {
    const seen: unknown[] = []
    const off = onViewChangedInOtherTab((s) => seen.push(s))
    window.dispatchEvent(new StorageEvent('storage', { key: 'other', newValue: 'x' }))
    expect(seen).toEqual([])
    off()
  })

  it('returns null feature when URL has view but no feature param', () => {
    window.history.replaceState(null, '', '/?view=coverage')
    expect(readPersistedView()).toEqual(view({ view: 'coverage' }))
  })

  it('falls back to localStorage with no feature key and returns null feature', () => {
    localStorage.setItem(KEY, JSON.stringify({ view: 'cleanup' }))
    expect(readPersistedView()).toEqual(view({ view: 'cleanup' }))
  })

  it('returns default when localStorage has no view key', () => {
    localStorage.setItem(KEY, JSON.stringify({ feature: 'x' }))
    expect(readPersistedView()).toEqual(view({}))
  })

  it('produces a bare pathname when persisting the default workspace view with no feature', () => {
    persistView(view({ view: 'workspace', feature: null }))
    expect(window.location.search).toBe('')
    expect(window.location.href).not.toContain('?')
  })

  it('treats missing feature key in storage event as null', () => {
    const seen: Array<{ view: string; feature: string | null }> = []
    const off = onViewChangedInOtherTab((s) => seen.push(s))
    window.dispatchEvent(new StorageEvent('storage', {
      key: KEY,
      newValue: JSON.stringify({ view: 'cleanup' }),
    }))
    expect(seen).toEqual([{ view: 'cleanup', feature: null }])
    off()
  })

  it('ignores storage events where the stored object has no view key', () => {
    const seen: unknown[] = []
    const off = onViewChangedInOtherTab((s) => seen.push(s))
    window.dispatchEvent(new StorageEvent('storage', {
      key: KEY,
      newValue: JSON.stringify({ feature: 'x' }),
    }))
    expect(seen).toEqual([])
    off()
  })
})

describe('workspace-view-state — run + dialog routing (R24)', () => {
  it('round-trips the selected run through the URL', () => {
    persistView(view({ view: 'workspace', feature: 'checkout', run: '7cvh' }))
    expect(window.location.search).toContain('run=7cvh')
    expect(readPersistedView()).toEqual(view({ feature: 'checkout', run: '7cvh' }))
  })

  it('restores a run on a bare workspace deep link (no view param)', () => {
    window.history.replaceState(null, '', '/?feature=checkout&run=7cvh')
    expect(readPersistedView()).toEqual(view({ feature: 'checkout', run: '7cvh' }))
  })

  it('drops the run param when no run is selected', () => {
    window.history.replaceState(null, '', '/?feature=checkout&run=7cvh')
    persistView(view({ feature: 'checkout', run: null }))
    expect(window.location.search).not.toContain('run=')
  })

  it('does NOT mirror run to localStorage (URL-only tier)', () => {
    persistView(view({ view: 'coverage', feature: 'checkout', run: '7cvh' }))
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({ view: 'coverage', feature: 'checkout' })
  })

  it('does NOT sync run cross-tab — feature compare across tabs is preserved', () => {
    const seen: Array<{ view: string; feature: string | null }> = []
    const off = onViewChangedInOtherTab((s) => seen.push(s))
    // A real cross-tab event carries only the durable tier (no run key).
    window.dispatchEvent(new StorageEvent('storage', {
      key: KEY,
      newValue: JSON.stringify({ view: 'coverage', feature: 'checkout' }),
    }))
    expect(seen).toEqual([{ view: 'coverage', feature: 'checkout' }])
    off()
  })

  it('round-trips the config dialog', () => {
    persistView(view({ feature: 'checkout', dialog: 'config' }))
    expect(window.location.search).toContain('dialog=config')
    expect(readPersistedView()).toEqual(view({ feature: 'checkout', dialog: 'config' }))
  })

  it('round-trips the feature-scoped verification dialog', () => {
    persistView(view({ feature: 'checkout', dialog: 'verification' }))
    expect(window.location.search).toContain('dialog=verification')
    expect(readPersistedView()).toEqual(view({ feature: 'checkout', dialog: 'verification' }))
  })

  it('round-trips the feature-scoped flight-start dialog (URL-only, not mirrored)', () => {
    persistView(view({ feature: 'checkout', dialog: 'flight-start' }))
    expect(window.location.search).toContain('dialog=flight-start')
    expect(readPersistedView()).toEqual(view({ feature: 'checkout', dialog: 'flight-start' }))
    expect(localStorage.getItem(KEY)).not.toContain('flight-start')
  })

  it('round-trips the new-flight launcher dialog (R40 — no feature qualifier needed)', () => {
    persistView(view({ dialog: 'flight-new' }))
    expect(window.location.search).toContain('dialog=flight-new')
    expect(readPersistedView()).toEqual(view({ dialog: 'flight-new' }))
    expect(localStorage.getItem(KEY)).not.toContain('flight-new')
  })

  it('round-trips the demo chooser, URL-only like every other dialog', () => {
    persistView(view({ dialog: 'demo' }))
    expect(window.location.search).toContain('dialog=demo')
    expect(readPersistedView()).toEqual(view({ dialog: 'demo' }))
    // Never mirrored to localStorage: a chooser open in one tab must not pop
    // open in another.
    expect(localStorage.getItem(KEY)).not.toContain('demo')
  })

  it('round-trips Project Settings, URL-only like every other dialog', () => {
    persistView(view({ dialog: 'settings' }))
    expect(window.location.search).toContain('dialog=settings')
    expect(readPersistedView()).toEqual(view({ dialog: 'settings' }))
    // Never mirrored to localStorage: settings open in one tab must not pop
    // open in another.
    expect(localStorage.getItem(KEY)).not.toContain('settings')
  })

  it('R50: ignores the retired add-test / portify dialogs in stale deep links', () => {
    window.history.replaceState(null, '', '/?dialog=add-test')
    expect(readPersistedView()).toEqual(view({}))
    window.history.replaceState(null, '', '/?dialog=portify&wf=wf_abc&feature=checkout')
    expect(readPersistedView()).toEqual(view({ feature: 'checkout' }))
  })

  it('R50: clears a stale wf param on the next persist', () => {
    window.history.replaceState(null, '', '/?feature=checkout&wf=wf_abc')
    persistView(view({ feature: 'checkout' }))
    expect(window.location.search).not.toContain('wf=')
  })

  it('R29: ignores the retired evaluation dialog in a stale deep link', () => {
    window.history.replaceState(null, '', '/?dialog=evaluation&task=task_abc&feature=checkout')
    expect(readPersistedView()).toEqual(view({ feature: 'checkout' }))
  })

  it('R29: clears a stale task param on the next persist', () => {
    window.history.replaceState(null, '', '/?feature=checkout&task=task_abc')
    persistView(view({ feature: 'checkout', dialog: 'config' }))
    expect(window.location.search).not.toContain('task=')
    expect(readPersistedView()).toEqual(view({ feature: 'checkout', dialog: 'config' }))
  })

  it('ignores an unknown dialog value in the URL', () => {
    window.history.replaceState(null, '', '/?dialog=bogus')
    expect(readPersistedView()).toEqual(view({}))
  })

  it('does NOT mirror dialog to localStorage (URL-only tier)', () => {
    persistView(view({ feature: 'checkout', dialog: 'config' }))
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({ view: 'workspace', feature: 'checkout' })
  })

  it('clears the dialog param on close (dialog → null)', () => {
    persistView(view({ feature: 'checkout', dialog: 'config' }))
    persistView(view({ feature: 'checkout', dialog: null }))
    expect(window.location.search).not.toContain('dialog=')
    expect(window.location.search).toContain('feature=checkout')
  })

  it('round-trips the flight id when view=flights (deep-linked flight detail)', () => {
    persistView(view({ view: 'flights', flight: 'fl_abc123' }))
    expect(window.location.search).toContain('view=flights')
    expect(window.location.search).toContain('flight=fl_abc123')
    const state = readPersistedView()
    expect(state.view).toBe('flights')
    expect(state.flight).toBe('fl_abc123')
  })

  it('drops a flight param found in the URL when the view is not flights (line 76 false branch)', () => {
    window.history.replaceState(null, '', '/?view=coverage&feature=checkout&flight=fl_stale')
    expect(readPersistedView()).toEqual(view({ view: 'coverage', feature: 'checkout' }))
  })

  it('returns null flight when view=flights but the URL has no flight param (line 76 || fallback)', () => {
    window.history.replaceState(null, '', '/?view=flights')
    expect(readPersistedView()).toEqual(view({ view: 'flights' }))
  })

  it('drops the flight param outside the flights view and keeps it out of localStorage', () => {
    persistView(view({ view: 'flights', flight: 'fl_abc123' }))
    persistView(view({ view: 'workspace', feature: 'checkout', flight: 'fl_abc123' }))
    expect(window.location.search).not.toContain('flight=')
    persistView(view({ view: 'flights', flight: 'fl_abc123' }))
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({ view: 'flights', feature: null })
  })

  // The stage qualifies an OPEN flight. Without it a drill-through's way back
  // re-ran the detail's auto-pick and landed on a different stage than the one
  // the user drilled from.
  it('round-trips the selected stage alongside its flight', () => {
    persistView(view({ view: 'flights', flight: 'fl_abc123', flightStage: 'specs-coverage' }))
    expect(window.location.search).toContain('stage=specs-coverage')
    expect(readPersistedView()).toEqual(view({ view: 'flights', flight: 'fl_abc123', flightStage: 'specs-coverage' }))
  })

  it('drops the stage without a flight to hang it on', () => {
    persistView(view({ view: 'flights', flight: 'fl_abc123', flightStage: 'portify' }))
    // The flights LANDING list — no flight open, so no stage to remember.
    persistView(view({ view: 'flights', flight: null, flightStage: 'portify' }))
    expect(window.location.search).not.toContain('stage=')
    // …and off the flights view entirely.
    persistView(view({ view: 'flights', flight: 'fl_abc123', flightStage: 'portify' }))
    persistView(view({ view: 'coverage', feature: 'checkout', flight: 'fl_abc123', flightStage: 'portify' }))
    expect(window.location.search).not.toContain('stage=')
  })

  it('ignores a stray stage param when no flight is open', () => {
    window.history.replaceState(null, '', '/?view=flights&stage=portify')
    expect(readPersistedView()).toEqual(view({ view: 'flights' }))
  })

  it('keeps the selected stage OUT of localStorage (URL-only tier)', () => {
    persistView(view({ view: 'flights', flight: 'fl_abc123', flightStage: 'specs-coverage' }))
    expect(localStorage.getItem(KEY)).not.toContain('specs-coverage')
  })

  // External authoring now surfaces on the flight's specs-coverage stage, so the
  // `draft` dialog and its id qualifier are tombstones like `wf` and `task`.
  it('ignores the retired draft dialog in a stale deep link', () => {
    window.history.replaceState(null, '', '/?dialog=draft&draft=dr_abc123&feature=checkout')
    expect(readPersistedView()).toEqual(view({ feature: 'checkout' }))
  })

  it('clears a stale draft param on the next persist', () => {
    window.history.replaceState(null, '', '/?feature=checkout&draft=dr_stale')
    persistView(view({ feature: 'checkout', dialog: 'config' }))
    expect(window.location.search).not.toContain('draft=')
    expect(readPersistedView()).toEqual(view({ feature: 'checkout', dialog: 'config' }))
  })

  it('round-trips the config dialog + its tab qualifier (URL-only, not mirrored)', () => {
    persistView(view({ feature: 'checkout', dialog: 'config', configTab: 'ports' }))
    expect(window.location.search).toContain('dialog=config')
    expect(window.location.search).toContain('tab=ports')
    expect(readPersistedView()).toEqual(view({ feature: 'checkout', dialog: 'config', configTab: 'ports' }))
    expect(localStorage.getItem(KEY)).not.toContain('ports')
  })

  it('reads the config dialog with no tab as a null qualifier (the mount picks its default)', () => {
    window.history.replaceState(null, '', '/?feature=checkout&dialog=config')
    expect(readPersistedView()).toEqual(view({ feature: 'checkout', dialog: 'config', configTab: null }))
  })

  it('ignores an unknown tab name', () => {
    window.history.replaceState(null, '', '/?feature=checkout&dialog=config&tab=bogus')
    expect(readPersistedView()).toEqual(view({ feature: 'checkout', dialog: 'config', configTab: null }))
  })

  it('drops a tab param found in the URL when the dialog is not config', () => {
    window.history.replaceState(null, '', '/?feature=checkout&dialog=verification&tab=ports')
    expect(readPersistedView()).toEqual(view({ feature: 'checkout', dialog: 'verification' }))
  })

  it('drops the tab param on close', () => {
    persistView(view({ feature: 'checkout', dialog: 'config', configTab: 'ports' }))
    persistView(view({ feature: 'checkout', dialog: null }))
    expect(window.location.search).not.toContain('tab=')
  })

  // The model matrix stacked over Project Settings — the `models` qualifier
  // on dialog=settings, same drop-unless-active gate as `tab` on config.
  it('round-trips the settings dialog + its models qualifier (URL-only, not mirrored)', () => {
    persistView(view({ dialog: 'settings', modelsAgent: 'claude' }))
    expect(window.location.search).toContain('dialog=settings')
    expect(window.location.search).toContain('models=claude')
    expect(readPersistedView()).toEqual(view({ dialog: 'settings', modelsAgent: 'claude' }))
    expect(localStorage.getItem(KEY)).not.toContain('claude')
  })

  it('reads settings with no models param as the dialog alone', () => {
    window.history.replaceState(null, '', '/?dialog=settings')
    expect(readPersistedView()).toEqual(view({ dialog: 'settings', modelsAgent: null }))
  })

  it('ignores an unknown models agent name', () => {
    window.history.replaceState(null, '', '/?dialog=settings&models=gemini')
    expect(readPersistedView()).toEqual(view({ dialog: 'settings', modelsAgent: null }))
  })

  it('drops a models param found in the URL when the dialog is not settings', () => {
    window.history.replaceState(null, '', '/?feature=checkout&dialog=config&models=claude')
    expect(readPersistedView()).toEqual(view({ feature: 'checkout', dialog: 'config' }))
  })

  it('drops the models param on close', () => {
    persistView(view({ dialog: 'settings', modelsAgent: 'codex' }))
    persistView(view({ dialog: null }))
    expect(window.location.search).not.toContain('models=')
  })
})
