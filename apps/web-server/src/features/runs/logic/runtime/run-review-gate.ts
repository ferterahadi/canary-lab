import type { RunStore } from '../run-store'
import { suiteExecutionRevision, suiteReviewRevision } from './suite-review'
import { suiteRuntimeInputTargetsForSnapshot } from './suite-runtime-inputs'
import type { RunTestReviewApproval } from '../../../../../../../shared/test-review'

/** A fresh snapshot must not erase the outstanding review from an abandoned
 * repair. Compare bytes again: abort may beat the filesystem watcher. */
export function assertNoPendingRunReview(store: Pick<RunStore, 'list' | 'get'>, feature: string, liveDir: string, startingRunId?: string): RunTestReviewApproval | undefined {
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
  throw Object.assign(new Error(
    `test_review_required: run ${manifest.runId} has suite changes that a fresh run would adopt without review. Use get_test_review and review_test_changes on that run. An active run may adopt and rerun; an ended run may approve the exact bytes for a new run or restore them.`,
  ), { statusCode: 409 })
}
