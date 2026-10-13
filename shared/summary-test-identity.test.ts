import { describe, expect, it } from 'vitest'
import { findSummaryTest } from './summary-test-identity'
import { collidingTests } from './__fixtures__/summary-test-identity'

describe('summary test identity', () => {
  it('prefers ids over names and supports renamed titles', () => {
    expect(findSummaryTest(collidingTests, { name: 'old-name', id: 'second' })).toBe(collidingTests[1])
    expect(findSummaryTest(collidingTests, { name: collidingTests[0].name, id: 'stale' })).toBeUndefined()
    expect(findSummaryTest([...collidingTests, collidingTests[1]], collidingTests[1])).toBeUndefined()
  })
  it('requires unambiguous legacy evidence and honors disabled fallback', () => {
    const legacy = collidingTests.map(({ id: _id, ...entry }) => entry)
    expect(findSummaryTest(legacy, { name: legacy[0].name })).toBeUndefined()
    expect(findSummaryTest(legacy, { ...legacy[1], location: `${legacy[1].location}:5`, id: 'older' })).toBe(legacy[1])
    expect(findSummaryTest(legacy, { ...legacy[1], location: 'other.spec.ts:30' })).toBeUndefined()
    expect(findSummaryTest(legacy, { ...legacy[1], allowNameFallback: false })).toBeUndefined()
    expect(findSummaryTest([legacy[0]], { name: legacy[0].name })).toBe(legacy[0])
    expect(findSummaryTest([{ name: 'x' }], { name: 'x', location: 'x:1' })).toBeUndefined()
  })
})
