import { isTerminalRunStatus } from '../../../../shared/run-state'
import { suiteReviewRevision } from '../features/runs/logic/runtime/suite-review'
import { suiteRuntimeInputTargetsForSnapshot } from '../features/runs/logic/runtime/suite-runtime-inputs'
import type { RunStore, RunStoreEvent } from '../features/runs/logic/run-store'

export const TEST_REVIEW_WAIT_MS = 30_000

/** Receipts survive a missed event, a reconnect, and the run advancing after
 * the click. A clean Git tree or an empty diff is never proof of approval. */
export function testReviewOutcome(store: RunStore, runId: string, revision: string) {
  const detail = store.get(runId)
  if (!detail) return { status: 'run-unavailable', runId }
  const decision = [...(detail.manifest.specEdits?.reviewDecisions ?? [])].reverse().find((item) => item.revision === revision)
  if (decision) return {
    status: decision.decision, runId, review_revision: revision,
    next: decision.decision === 'adopted'
      ? 'The human accepted these test changes. Continue with wait_for_heal_task for the runner result; acceptance is not a pass.'
      : decision.decision === 'approved-for-new-run'
        ? 'The human approved these exact candidate bytes for a new run. Call start_run without run_ref; the approval is not a pass and the old result stays immutable.'
      : 'The human restored the recorded tests. Continue with wait_for_heal_task and fix the app against those tests. Do not reapply the rejected test edits.',
    nextSteps: decision.decision === 'approved-for-new-run' ? ['start_run'] : ['wait_for_heal_task'],
  }
  if (isTerminalRunStatus(detail.manifest.status)) {
    const snapshot = detail.manifest.suiteSnapshot
    try {
      if (snapshot?.kind === 'taken' && detail.manifest.featureDir
        && suiteReviewRevision(snapshot.dir, detail.manifest.featureDir, suiteRuntimeInputTargetsForSnapshot(snapshot.dir)) === revision) return null
    } catch { /* Missing source cannot remain reviewable. */ }
    return { status: 'run-ended', runId, next: 'The run ended and these are no longer the current reviewed bytes. Fetch the current review; do not infer approval.' }
  }
  return null
}

type ReviewWaitResult = NonNullable<ReturnType<typeof testReviewOutcome>> | {
  status: 'still_waiting' | 'review-changed'
  runId: string
  review_revision: string
  next: string
}

export async function waitForTestReview(store: RunStore, runId: string, revision: string, timeoutMs = TEST_REVIEW_WAIT_MS): Promise<ReviewWaitResult> {
  const immediate = testReviewOutcome(store, runId, revision)
  if (immediate) return immediate
  return new Promise<ReviewWaitResult>((resolve) => {
    const finish = (result: ReviewWaitResult) => {
      store.offEvent(onEvent)
      clearTimeout(timer)
      resolve(result)
    }
    const check = () => {
      const result = testReviewOutcome(store, runId, revision)
      if (result) finish(result)
    }
    const onEvent = (event: RunStoreEvent) => {
      if (!event.runId || event.runId === runId) check()
    }
    const timer = setTimeout(() => {
      const result = testReviewOutcome(store, runId, revision)
      if (result) return finish(result)
      const manifest = store.get(runId)!.manifest
      let unchanged = false
      try {
        unchanged = manifest.suiteSnapshot?.kind === 'taken' && !!manifest.featureDir
          && suiteReviewRevision(manifest.suiteSnapshot.dir, manifest.featureDir, suiteRuntimeInputTargetsForSnapshot(manifest.suiteSnapshot.dir)) === revision
      } catch { /* Missing source cannot be accepted as the reviewed revision. */ }
      finish({ status: unchanged ? 'still_waiting' : 'review-changed', runId, review_revision: revision,
        next: unchanged
          ? 'No browser decision is recorded yet. Repeat review_test_changes with the same runId, review_revision, browser_wait_token and wait_for_decision:true. Do not click review controls yourself.'
          : 'The suite changed without a decision for this revision. Fetch get_test_review and show the fresh diff before requesting another review.' })
    }, Math.min(Math.max(timeoutMs, 1), TEST_REVIEW_WAIT_MS))
    timer.unref()
    store.onEvent(onEvent)
    // Close the read/subscribe gap. During adoption the snapshot moves before
    // its receipt is written; only the receipt may resolve the live wait.
    check()
  })
}
