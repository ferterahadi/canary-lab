import { expect, it } from 'vitest'
import { qualitySummary, qualitySummaryForAudience } from './assertions'
import type { AssertionQuality, TestReviewAssertion } from './types'

const assertion = (quality: AssertionQuality): TestReviewAssertion => ({
  kind: 'direct', label: 'check', quality, rationale: '', snippet: '',
})

it('preserves exact labels, category ordering and repeated counts for both audiences', () => {
  const assertions = ['unknown', 'shallow', 'strict', 'moderate', 'strict'].map((quality) => assertion(quality as AssertionQuality))
  assertions[0].nested = [assertion('strict')]
  const before = structuredClone(assertions)
  expect(qualitySummary(assertions)).toBe('2 strict, 1 moderate, 1 shallow, 1 unknown')
  expect(qualitySummaryForAudience(assertions)).toBe('2 exact, 1 behavioral, 1 surface-level, 1 not graded')
  expect(assertions).toEqual(before)
})

it('omits absent categories and returns no text for an empty list', () => {
  expect(qualitySummary([])).toBe('')
  expect(qualitySummaryForAudience([])).toBe('')
  expect(qualitySummary([assertion('shallow')])).toBe('1 shallow')
  expect(qualitySummaryForAudience([assertion('shallow')])).toBe('1 surface-level')
})
