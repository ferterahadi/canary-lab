import type { RunTestReview, TestReviewReceipt } from '../test-review'

/** A pending active-run scenario, independent of the production policy reader. */
export function activeRunReview(overrides: Partial<RunTestReview> = {}): RunTestReview {
  return {
    runId: 'run-1', feature: 'alpha', baseline: 'run-start', review_revision: 'a'.repeat(64),
    files: [{ file: 'e2e/a.spec.ts', change: 'modified' }], canAdopt: true,
    reviewState: 'pending-active', allowedActions: ['adopt-and-rerun', 'restore', 'leave-pending'],
    nextAction: 'rerun-current', ...overrides,
  }
}

export function settledRunReview(overrides: Partial<RunTestReview> = {}): RunTestReview {
  return {
    ...activeRunReview(), files: [], canAdopt: false, reviewState: 'settled',
    allowedActions: [], nextAction: 'none', ...overrides,
  }
}

/** Decision and side effects remain explicit at the call site. */
export function reviewReceipt(input: Omit<TestReviewReceipt, 'at'> & { at?: string }): TestReviewReceipt {
  return { at: 'now', ...input }
}
