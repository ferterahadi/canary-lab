import type { RunsRouteDeps } from '../routes/runs-route-deps'
import type { TestReviewDecision, TestReviewReceipt } from '../../../../../../shared/test-review'
import { isTerminalRunStatus } from '../../../../../../shared/run-state'
import { withRunReviewLock } from './test-review-lock'
import { suiteReviewFiles } from './runtime/suite-review'
import { suiteRuntimeInputTargetsForSnapshot } from './runtime/suite-runtime-inputs'
import { commitReviewedFiles } from './test-review-acceptance'
import { retainRunSource } from './runtime/run-execution-evidence'
import { runDirFor } from './runtime/run-paths'
import { checkRestartEligibility } from './restart-eligibility'
import { publishWorkspaceEvent } from '../../../shared/workspace-events'
import { recordRunDecision } from './run-lifecycle-service'

function refuse(reason: string, git?: TestReviewReceipt['git']): never {
  throw Object.assign(new Error(reason), { statusCode: 409, reason, ...(git ? { git } : {}) })
}

/** Browser and elicited agent decisions enter the same revision-bound writer. */
export function acceptRunReview(deps: Pick<RunsRouteDeps, 'store' | 'dirtySpecStore' | 'workspaceEvents'>, runId: string, revision: string): Promise<TestReviewReceipt> {
  return withRunReviewLock(deps.store, runId, async () => {
    const detail = deps.store.get(runId)
    if (!detail) throw Object.assign(new Error('run-not-found'), { statusCode: 404 })
    if (!/^[a-f0-9]{64}$/.test(revision)) throw Object.assign(new Error('An exact review revision is required'), { statusCode: 400 })
    const existing = [...(detail.manifest.specEdits?.reviewDecisions ?? [])].reverse().find((d) => d.revision === revision)
    if (existing?.receipt?.decision === 'accepted') return existing.receipt
    if (existing) refuse(existing.receipt ? 'review-decision-conflict' : 'review-already-settled')
    const { suiteSnapshot: snapshot, featureDir } = detail.manifest
    if (snapshot?.kind !== 'taken' || !featureDir) refuse('Run snapshot unavailable')
    const exclusions = suiteRuntimeInputTargetsForSnapshot(snapshot.dir)
    const review = suiteReviewFiles(snapshot.dir, featureDir, exclusions)
    if (review.revision !== revision) refuse('review-changed')
    if (!review.files.length) refuse('nothing-to-accept')
    const orch = deps.store.registry.get(runId)
    if (!orch?.adoptSpecEdits && !isTerminalRunStatus(detail.manifest.status)) refuse('The run is not ready to accept reviewed files.')
    const git = await commitReviewedFiles(detail.manifest.feature, featureDir, review.files.map((f) => f.file))
    if (suiteReviewFiles(snapshot.dir, featureDir, exclusions).revision !== revision) refuse('review-changed', git)
    let receipt: TestReviewReceipt
    if (orch?.adoptSpecEdits) {
      const adopted = await orch.adoptSpecEdits(revision, git)
      if (!adopted.ok) refuse(adopted.reason, git)
      receipt = [...(deps.store.get(runId)?.manifest.specEdits?.reviewDecisions ?? [])].reverse().find((d) => d.revision === revision)?.receipt
        ?? { decision: 'accepted', review_revision: revision, files: adopted.adopted,
          at: new Date().toISOString(), git, execution: { status: 'rerun-requested', runId } }
    } else {
      retainRunSource(runDirFor(deps.store.logsDir, runId), snapshot.dir)
      const eligible = checkRestartEligibility(detail.manifest, runDirFor(deps.store.logsDir, runId), 'run')
      const at = new Date().toISOString()
      receipt = { decision: 'accepted', review_revision: revision, files: review.files.map((f) => f.file), at, git,
        execution: { status: eligible.ok ? 'continuation-ready' : 'new-run-required', runId } }
      const decision: TestReviewDecision = { at, revision, decision: eligible.ok ? 'approved-for-continuation' : 'approved-for-new-run', receipt }
      const previous = deps.store.get(runId)!.manifest.specEdits
      deps.store.patchManifest(runId, { specEdits: { checkedAt: at, pending: [], adopted: previous?.adopted ?? [],
        reviewDecisions: [...(previous?.reviewDecisions ?? []), decision] } })
      recordRunDecision(deps.store, runId, 'Test changes accepted and committed. Awaiting a separate execution request; the previous result is unchanged.', 'accepted-awaiting-execution')
    }
    await deps.dirtySpecStore?.recompute(detail.manifest.feature, featureDir)
    publishWorkspaceEvent(deps.workspaceEvents, { type: 'tests-changed', feature: detail.manifest.feature })
    return receipt
  })
}
