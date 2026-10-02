import { describe, expect, it } from 'vitest'
import { isWithin } from './path-containment'

describe('isWithin', () => {
  it('is true for the root itself and for descendants', () => {
    expect(isWithin('/a/b', '/a/b')).toBe(true)
    expect(isWithin('/a/b', '/a/b/c/d')).toBe(true)
  })

  it('is false for a sibling, an ancestor, or an unrelated absolute path', () => {
    expect(isWithin('/a/b', '/a/bb')).toBe(false)
    expect(isWithin('/a/b', '/a')).toBe(false)
    expect(isWithin('/a/b', '/x/y')).toBe(false)
  })
})
