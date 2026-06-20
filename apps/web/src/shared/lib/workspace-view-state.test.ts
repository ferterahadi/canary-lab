// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readPersistedView, persistView, onViewChangedInOtherTab } from './workspace-view-state'

const KEY = 'cl.workspace.view'

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
    expect(readPersistedView()).toEqual({ view: 'workspace', feature: null })
  })

  it('round-trips through the URL on persist (survives refresh)', () => {
    persistView({ view: 'coverage', feature: 'checkout' })
    expect(window.location.search).toContain('view=coverage')
    expect(window.location.search).toContain('feature=checkout')
    // A fresh read (as on refresh) recovers the same state from the URL.
    expect(readPersistedView()).toEqual({ view: 'coverage', feature: 'checkout' })
  })

  it('mirrors to localStorage so other tabs can read it', () => {
    persistView({ view: 'coverage', feature: 'checkout' })
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({ view: 'coverage', feature: 'checkout' })
  })

  it('URL takes precedence over localStorage', () => {
    localStorage.setItem(KEY, JSON.stringify({ view: 'cleanup', feature: null }))
    window.history.replaceState(null, '', '/?view=coverage&feature=pat')
    expect(readPersistedView()).toEqual({ view: 'coverage', feature: 'pat' })
  })

  it('falls back to localStorage when the URL has no view', () => {
    localStorage.setItem(KEY, JSON.stringify({ view: 'coverage', feature: 'pat' }))
    expect(readPersistedView()).toEqual({ view: 'coverage', feature: 'pat' })
  })

  it('clears the query params when returning to the workspace', () => {
    persistView({ view: 'coverage', feature: 'checkout' })
    persistView({ view: 'workspace', feature: 'checkout' })
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
    persistView({ view: 'coverage', feature: null })
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

  // line 27: feature param absent from URL → params.get('feature') || null returns null
  it('returns null feature when URL has view but no feature param', () => {
    window.history.replaceState(null, '', '/?view=coverage')
    expect(readPersistedView()).toEqual({ view: 'coverage', feature: null })
  })

  // lines 33-34: localStorage entry without a feature key → feature: parsed.feature ?? null
  it('falls back to localStorage with no feature key and returns null feature', () => {
    localStorage.setItem(KEY, JSON.stringify({ view: 'cleanup' }))
    expect(readPersistedView()).toEqual({ view: 'cleanup', feature: null })
  })

  // line 33: localStorage entry with no view key → parsed.view ?? null = null → isView(null) false → default
  it('returns default when localStorage has no view key', () => {
    localStorage.setItem(KEY, JSON.stringify({ feature: 'x' }))
    expect(readPersistedView()).toEqual({ view: 'workspace', feature: null })
  })

  // line 51: empty query string path — view=workspace + no feature → qs is empty → no '?'
  it('produces a bare pathname when persisting the default workspace view with no feature', () => {
    persistView({ view: 'workspace', feature: null })
    expect(window.location.search).toBe('')
    expect(window.location.href).not.toContain('?')
  })

  // line 65: onViewChangedInOtherTab storage event where parsed.feature is absent → ?? null
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

  // line 65: storage event where parsed.view is absent → isView(null) false → callback not called
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
