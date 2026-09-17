import type { RunStore } from '../run-store'
import { suiteExecutionRevision } from './suite-review'

/** A fresh snapshot must not erase the outstanding review from an abandoned
 * repair. Compare bytes again: abort may beat the filesystem watcher. */
export function assertNoPendingRunReview(store: Pick<RunStore, 'list' | 'get'>, feature: string, liveDir: string, startingRunId?: string): void {
  const latest = store.list({ feature }).find((entry) => entry.runId !== startingRunId && entry.status !== 'queued' && (entry.executionType === undefined || entry.executionType === 'run'))
  if (!latest) return
  const detail = store.get(latest.runId)
  const manifest = detail?.manifest
  if (!manifest || manifest.suiteSnapshot?.kind !== 'taken') return
  if (manifest.status === 'passed' && !manifest.specEdits?.pending.length) return
  const snapshot = manifest.suiteSnapshot.dir
  if (suiteExecutionRevision(snapshot, liveDir) === suiteExecutionRevision(snapshot, snapshot)) return
  throw Object.assign(new Error(
    `test_review_required: run ${manifest.runId} has suite changes that a fresh run would adopt without review. Continue that run with start_run(run_ref:"${manifest.runId}"), then use get_test_review and review_test_changes to review and adopt the changes.`,
  ), { statusCode: 409 })
}
