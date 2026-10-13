import { afterEach, describe, expect, it, vi } from 'vitest'
import { readGroupOpen, writeGroupOpen } from './group-open-state'

const KEY = 'cl-test-groups'

afterEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
})

describe('readGroupOpen', () => {
  it('falls back to the surface default for a group the user never toggled', () => {
    // The default is per-surface on purpose: the features column rests open
    // and the flights picker rests collapsed.
    expect(readGroupOpen(KEY, 'alpha')).toBe(true)
    expect(readGroupOpen(KEY, 'alpha', false)).toBe(false)
  })

  it('honours an explicit stored boolean over the default', () => {
    localStorage.setItem(KEY, JSON.stringify({ alpha: false, beta: true }))
    expect(readGroupOpen(KEY, 'alpha', true)).toBe(false)
    expect(readGroupOpen(KEY, 'beta', false)).toBe(true)
  })

  it('falls back to the default for a group missing from a stored map', () => {
    localStorage.setItem(KEY, JSON.stringify({ alpha: false }))
    expect(readGroupOpen(KEY, 'gamma', true)).toBe(true)
    expect(readGroupOpen(KEY, 'gamma', false)).toBe(false)
  })

  it('falls back to the default when the stored value is not JSON', () => {
    localStorage.setItem(KEY, '{not json')
    expect(readGroupOpen(KEY, 'alpha', false)).toBe(false)
  })

  it('falls back to the default when storage itself throws', () => {
    // Private-mode browsers throw on access rather than returning null, and a
    // disclosure accordion must not take the whole panel down with it.
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied') })
    expect(readGroupOpen(KEY, 'alpha', true)).toBe(true)
    expect(readGroupOpen(KEY, 'alpha', false)).toBe(false)
  })
})

describe('writeGroupOpen', () => {
  it('creates the map on first write', () => {
    writeGroupOpen(KEY, 'alpha', false)
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({ alpha: false })
  })

  it('merges into an existing map rather than replacing it', () => {
    // Both surfaces write through this helper; clobbering the map would reset
    // every other group the user had collapsed.
    localStorage.setItem(KEY, JSON.stringify({ alpha: false }))
    writeGroupOpen(KEY, 'beta', true)
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({ alpha: false, beta: true })
  })

  it('round-trips through readGroupOpen', () => {
    writeGroupOpen(KEY, 'alpha', false)
    expect(readGroupOpen(KEY, 'alpha', true)).toBe(false)
  })

  it('is non-fatal when storage is unavailable', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota') })
    expect(() => writeGroupOpen(KEY, 'alpha', false)).not.toThrow()
  })
})
