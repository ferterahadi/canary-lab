import type { RunStore } from '../run-store'
import { suiteExecutionRevision, suiteReviewFiles, suiteReviewRevision } from './suite-review'
import { suiteRuntimeInputTargetsForSnapshot } from './suite-runtime-inputs'
import { testReviewUrl, type RunTestReviewApproval, type TestReviewRequiredInfo } from '../../../../../../../shared/test-review'

/** A fresh snapshot must not erase the outstanding review from an abandoned
 * repair. Compare bytes again: abort may beat the filesystem watcher. */
function runReviewGate(store: Pick<RunStore, 'list' | 'get'>, feature: string, liveDir: string, startingRunId?: string): RunTestReviewApproval | TestReviewRequiredInfo | undefined {
  const latest = store.list({ feature }).find((entry) => entry.runId !== startingRunId && entry.status !== 'queued' && (entry.executionType === undefined || entry.executionType === 'run'))
  if (!latest) return
  const detail = store.get(latest.runId)
  const manifest = detail?.manifest
  if (!manifest || manifest.suiteSnapshot?.kind !== 'taken') return
  if (manifest.status === 'passed' && !manifest.specEdits?.pending.length) return
  const snapshot = manifest.suiteSnapshot.dir
  const runtimeInputs = suiteRuntimeInputTargetsForSnapshot(snapshot)
  if (suiteExecutionRevision(snapshot, liveDir, runtimeInputs) === suiteExecutionRevision(snapshot, snapshot, runtimeInputs)) return undefined
  const revision = suiteReviewRevision(snapshot, liveDir, runtimeInputs)
  const approval = [...(manifest.specEdits?.reviewDecisions ?? [])].reverse().find((item) =>
    item.revision === revision && item.decision === 'approved-for-new-run',
  )
  if (approval) return { sourceRunId: manifest.runId, revision, approvedAt: approval.at }
  if (manifest.status === 'passed' && !manifest.specEdits?.pending.length) return undefined
  return {
    type: 'test_review_required', feature, runId: manifest.runId, review_revision: revision,
    changedFileCount: suiteReviewFiles(snapshot, liveDir, runtimeInputs).files.length,
    reviewUrl: testReviewUrl(feature, manifest.runId),
    error: 'Review the test changes before this run can start. Your run request will continue in its original client after you decide.',
  }
}

/** The notification projection and start gate use the same byte-level fact;
 * terminal status and Git cleanliness do not settle a pending review. */
export function pendingRunReview(store: Pick<RunStore, 'list' | 'get'>, feature: string, liveDir: string, startingRunId?: string): TestReviewRequiredInfo | undefined {
  const gate = runReviewGate(store, feature, liveDir, startingRunId)
  return gate && 'type' in gate ? gate : undefined
}

export function assertNoPendingRunReview(store: Pick<RunStore, 'list' | 'get'>, feature: string, liveDir: string, startingRunId?: string): RunTestReviewApproval | undefined {
  const gate = runReviewGate(store, feature, liveDir, startingRunId)
  if (!gate || !('type' in gate)) return gate
  throw Object.assign(new Error(
    `test_review_required: run ${gate.runId} has suite changes that a fresh run would adopt without review. Use get_test_review and review_test_changes on that run. An active run may adopt and rerun; an ended run may approve the exact bytes for a new run or restore them.`,
  ), { statusCode: 409, testReviewRequired: gate })
}
