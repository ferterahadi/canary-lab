import { expect, it } from 'vitest'
import { deriveRunReviewCapabilities, normalizeRunTestReview } from './test-review'
import { activeRunReview, settledRunReview } from './__fixtures__/test-review'

it.each([activeRunReview(), settledRunReview(), { ...activeRunReview(), reviewState: 'locked' as const, allowedActions: [] }])('preserves explicit review capabilities: $reviewState', (review) => {
  expect(normalizeRunTestReview(review)).toEqual(review)
})
it('fills only absent legacy capabilities', () => {
  expect(normalizeRunTestReview({ canAdopt: true }).allowedActions).toEqual(['adopt-and-rerun', 'restore', 'leave-pending'])
  expect(normalizeRunTestReview({ canAdopt: false }).reviewState).toBeUndefined()
  expect(normalizeRunTestReview({ canAdopt: true, allowedActions: [] }).allowedActions).toEqual([])
  expect(normalizeRunTestReview({ canAdopt: true, nextAction: 'none' }).nextAction).toBe('none')
})
it('derives capabilities from the registry and recorded decision, never status alone', () => {
  expect(deriveRunReviewCapabilities(false, false, undefined, true).reviewState).toBe('locked')
  expect(deriveRunReviewCapabilities(true, false, undefined, true).allowedActions).toContain('adopt-and-rerun')
  expect(deriveRunReviewCapabilities(false, true, undefined, true).allowedActions).toContain('approve-new-run')
  expect(deriveRunReviewCapabilities(true, true, undefined, false).reviewState).toBe('settled')
  expect(deriveRunReviewCapabilities(false, true, { at: 'now', revision: 'revision', decision: 'approved-for-new-run' }, true).nextAction).toBe('start-new-run')
})
