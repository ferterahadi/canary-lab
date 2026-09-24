import type { ReadableTest, ReadableTestStory } from './readable-tests/types'
import type { SpecDiff } from './verification-strength/types'

export type RunRequestOwner = { kind: 'internal' } | {
  kind: 'external'
  sessionId: string
  clientKind: string
  conversationName?: string
}

/** Approval belongs to the reviewed bytes; continuation belongs to the client
 * that requested execution. Opening a review never transfers that ownership. */
export interface RunStartRequest {
  requestId: string
  feature: string
  owner: RunRequestOwner
  status: 'awaiting-review' | 'ready' | 'starting' | 'started' | 'queued' | 'cancelled' | 'failed'
  version: number
  createdAt: string
  updatedAt: string
  review: { runId: string; revision: string }
  runId?: string
  error?: string
}

export interface TestReviewRequiredInfo {
  type: 'test_review_required'
  error: string
  feature: string
  runId: string
  review_revision: string
  changedFileCount: number
  reviewUrl: string
  request?: RunStartRequest
}

export function testReviewUrl(feature: string, runId: string): string {
  return `/?${new URLSearchParams({ feature, run: runId, dialog: 'tests-review', reviewBase: 'run', reviewMode: 'code' })}`
}

export interface VersionTest {
  file: string
  name: string
  line: number
  endLine: number
  /** Exact recorded counterpart, including the old title of a renamed test. */
  previous?: { name: string; line: number; endLine: number }
}
export type TestChangeKind = 'added' | 'changed' | 'removed'
export type TestVersionChanges = Record<TestChangeKind, VersionTest[]>
export interface RunDifference { file: string; affectedTests: string[] }
export type TestSourceComparison = {
  files: string[]
  differences: RunDifference[]
} & ({ state: 'ready'; changes: TestVersionChanges } | { state: 'unavailable'; reasons: string[] })

/** Exact run-start versus live-suite review used by both agent elicitation and
 * the browser decision surface. `patchPath` is omitted by the browser's
 * lightweight reconciliation read. */
export interface RunTestReview {
  runId: string
  feature: string
  baseline: 'run-start'
  review_revision: string
  files: Array<{ file: string; change: 'added' | 'deleted' | 'modified' }>
  canAdopt: boolean
  reviewState: 'pending-active' | 'pending-terminal' | 'settled' | 'locked'
  allowedActions: Array<'adopt-and-rerun' | 'approve-new-run' | 'restore' | 'leave-pending'>
  nextAction: 'rerun-current' | 'start-new-run' | 'restore-or-leave' | 'none'
  patchPath?: string
  patch?: string
  receipt?: TestReviewReceipt
}

export interface TestReviewGitReceipt {
  status: 'committed' | 'already-committed' | 'not-requested'
  commit?: string
}

export type TestReviewExecutionReceipt =
  | { status: 'rerun-requested'; runId: string }
  | { status: 'new-run-required'; runId: string }
  | { status: 'none' }

/** Durable result of one explicit human decision for one exact review. Git
 * state alone never creates this receipt; only the review decision routes do. */
export interface TestReviewReceipt {
  decision: 'accepted' | 'restored'
  review_revision: string
  files: string[]
  at: string
  git: TestReviewGitReceipt
  execution: TestReviewExecutionReceipt
}

/** A human decision about one exact run-snapshot versus live-suite revision. */
export interface TestReviewDecision {
  at: string
  revision: string
  decision: 'adopted' | 'approved-for-new-run' | 'restored'
  receipt?: TestReviewReceipt
}

export interface FeatureTestReview {
  feature: string
  baseline: 'head'
  review_revision: string
  files: Array<{ file: string; change: 'added' | 'deleted' | 'modified' }>
  receipt?: TestReviewReceipt
}

/** Exact terminal-run approval carried into the new run that executes it. */
export interface RunTestReviewApproval {
  sourceRunId: string
  revision: string
  approvedAt: string
}

export interface ReviewTestSource {
  name: string
  line: number
  endLine: number
  readable: ReadableTest
}

export interface ReviewSource {
  source: string
  tests: ReviewTestSource[]
  /** Whole-file English, including module setup and test registration. */
  story?: ReadableTestStory
  parseError?: string
}

/** One read of each version supplies both context and advisory assessments. */
export interface TestFileReview {
  file: string
  /** Helpers/config belong to the approved snapshot but are not test declarations. */
  supportingFile?: boolean
  currentPath: string
  baseline: 'head' | 'run-start'
  before: ReviewSource
  after: ReviewSource
  patch: string
  assessment: SpecDiff
  /** Semantic source edits for test navigation; the raw patch remains complete. */
  meaningfulChanges?: { before: number[]; after: number[] }
  comparisonAlignment?: Array<{ before?: { line: number; endLine: number }; after?: { line: number; endLine: number } }>
}
