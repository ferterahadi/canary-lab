import { describe, expect, it } from 'vitest'
import {
  EMPTY_INVALIDATION,
  bumpInvalidation,
  invalidationSlot,
  readInvalidation,
} from './invalidation-bus'

describe('invalidationSlot', () => {
  it('uses the bare topic when unscoped', () => {
    expect(invalidationSlot('coverage')).toBe('coverage')
  })
  it('qualifies with the scope when given', () => {
    expect(invalidationSlot('journal', 'run-7cvh')).toBe('journal:run-7cvh')
  })
})

describe('readInvalidation', () => {
  it('reads 0 for an unbumped slot (matches the old useState(0))', () => {
    expect(readInvalidation(EMPTY_INVALIDATION, 'tests')).toBe(0)
    expect(readInvalidation(EMPTY_INVALIDATION, 'journal', 'run-1')).toBe(0)
  })
})

describe('bumpInvalidation', () => {
  it('increments from 0 on first bump', () => {
    const next = bumpInvalidation(EMPTY_INVALIDATION, 'coverage')
    expect(readInvalidation(next, 'coverage')).toBe(1)
  })

  it('increments the existing version on repeat bumps', () => {
    let s = bumpInvalidation(EMPTY_INVALIDATION, 'ports')
    s = bumpInvalidation(s, 'ports')
    s = bumpInvalidation(s, 'ports')
    expect(readInvalidation(s, 'ports')).toBe(3)
  })

  it('keeps topics isolated', () => {
    let s = bumpInvalidation(EMPTY_INVALIDATION, 'repos')
    s = bumpInvalidation(s, 'flights')
    expect(readInvalidation(s, 'repos')).toBe(1)
    expect(readInvalidation(s, 'flights')).toBe(1)
    expect(readInvalidation(s, 'coverage')).toBe(0)
  })

  it('keeps scopes of the same topic isolated', () => {
    let s = bumpInvalidation(EMPTY_INVALIDATION, 'journal', 'run-a')
    s = bumpInvalidation(s, 'journal', 'run-a')
    s = bumpInvalidation(s, 'journal', 'run-b')
    expect(readInvalidation(s, 'journal', 'run-a')).toBe(2)
    expect(readInvalidation(s, 'journal', 'run-b')).toBe(1)
  })

  it('does not mutate the previous state (fresh reference for React)', () => {
    const prev = bumpInvalidation(EMPTY_INVALIDATION, 'tests')
    const next = bumpInvalidation(prev, 'tests')
    expect(next).not.toBe(prev)
    expect(readInvalidation(prev, 'tests')).toBe(1)
    expect(readInvalidation(next, 'tests')).toBe(2)
  })
})
