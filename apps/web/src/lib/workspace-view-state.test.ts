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

  it('ignores unrelated storage keys', () => {
    const seen: unknown[] = []
    const off = onViewChangedInOtherTab((s) => seen.push(s))
    window.dispatchEvent(new StorageEvent('storage', { key: 'other', newValue: 'x' }))
    expect(seen).toEqual([])
    off()
  })
})
