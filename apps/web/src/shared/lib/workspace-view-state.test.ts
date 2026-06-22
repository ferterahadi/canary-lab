// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readPersistedView, persistView, onViewChangedInOtherTab, type PersistedView } from './workspace-view-state'

const KEY = 'cl.workspace.view'

/** Build a full PersistedView with sensible defaults for the fields under test. */
function view(partial: Partial<PersistedView>): PersistedView {
  return { view: 'workspace', feature: null, run: null, dialog: null, wf: null, ...partial }
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

  it('round-trips the add-test dialog with no feature', () => {
    persistView(view({ dialog: 'add-test' }))
    expect(readPersistedView()).toEqual(view({ dialog: 'add-test' }))
  })

  it('round-trips the feature-scoped verification dialog', () => {
    persistView(view({ feature: 'checkout', dialog: 'verification' }))
    expect(window.location.search).toContain('dialog=verification')
    expect(readPersistedView()).toEqual(view({ feature: 'checkout', dialog: 'verification' }))
  })

  it('round-trips a portify revisit (dialog + wf qualifier)', () => {
    persistView(view({ feature: 'checkout', dialog: 'portify', wf: 'wf_abc' }))
    expect(window.location.search).toContain('dialog=portify')
    expect(window.location.search).toContain('wf=wf_abc')
    expect(readPersistedView()).toEqual(view({ feature: 'checkout', dialog: 'portify', wf: 'wf_abc' }))
  })

  it('treats a portify dialog with no wf as start-new (wf omitted)', () => {
    persistView(view({ feature: 'checkout', dialog: 'portify', wf: null }))
    expect(window.location.search).not.toContain('wf=')
    expect(readPersistedView()).toEqual(view({ feature: 'checkout', dialog: 'portify' }))
  })

  it('drops a stray wf when the dialog is not portify', () => {
    persistView(view({ feature: 'checkout', dialog: 'config', wf: 'wf_abc' }))
    expect(window.location.search).not.toContain('wf=')
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
})
