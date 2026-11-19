import fs from 'fs'
import type { ServiceManifestEntry } from '../../../../../../../shared/run-manifest'
import { claimedSingleAttempt, NEW_RUN_REQUIRED_MESSAGE } from '../../../../shared/single-attempt'
import type { RunContext } from './run-context'
import { readManifest } from './manifest'
import { captureDirtySpecBaseline, prepareRun } from './run-manifest-writer'
import { adoptPendingSpecEdits, refreshSpecEdits, snapshotSuite } from './run-suite-snapshot'
import { suiteReviewFiles } from './suite-review'
import { suiteRuntimeInputTargetsForSnapshot } from './suite-runtime-inputs'
import { materializeSuiteRuntimeInputs, prepareSuiteRuntimeInputs } from './suite-runtime-inputs'

/** Both restart entry points need the recorded tests and fresh runtime inputs
 * before an agent or service can run. Local heal still defers service startup
 * until the agent signals; this preparation does not boot anything. */
export async function prepareRunForExecution(ctx: RunContext, serviceStatus: ServiceManifestEntry['status'], resume: boolean): Promise<void> {
  if (ctx.executionPrepared) { ctx.executionPrepared = false; return }
  const previous = resume ? readManifest(ctx.paths.manifestPath) : null
  if (claimedSingleAttempt(ctx.runDir, previous?.singleAttempt ?? ctx.feature.singleAttempt)) {
    throw new Error(NEW_RUN_REQUIRED_MESSAGE)
  }
  if (previous?.suiteSnapshot?.kind === 'taken' && !fs.existsSync(ctx.paths.suiteSnapshotDir)) {
    throw new Error('Cannot resume: the recorded suite snapshot is missing. Restore it before continuing this run.')
  }
  // Resume never replaces retained tests with mutable live source. Runtime
  // inputs are separately owned and recreated after terminal cleanup.
  if (resume && fs.existsSync(ctx.paths.suiteSnapshotDir)) {
    const review = suiteReviewFiles(ctx.suiteDir, ctx.feature.featureDir, suiteRuntimeInputTargetsForSnapshot(ctx.suiteDir))
    const decision = previous?.specEdits?.reviewDecisions?.find((d) => d.revision === review.revision && d.receipt?.decision === 'accepted')
    if (review.files.length && decision) {
      const adopted = await adoptPendingSpecEdits(ctx, 'human', review.revision, decision.receipt?.git)
      if (!adopted.ok) throw new Error(`Cannot continue approved suite: ${adopted.reason}`)
      ctx.approvedContinuation = true
      // The retained execution owns old results. No old pass can verify new bytes.
      fs.rmSync(ctx.paths.summaryPath, { force: true })
    } else if (review.files.length && previous?.specEdits?.reviewDecisions?.some((d) => d.receipt?.decision === 'accepted')) {
      throw new Error('Approved test review changed before continuation; review the latest source.')
    }
    prepareSuiteRuntimeInputs(ctx)
    materializeSuiteRuntimeInputs(ctx)
    refreshSpecEdits(ctx, ctx.feature.name)
  }
  prepareRun(ctx, serviceStatus, resume ? readManifest(ctx.paths.manifestPath) ?? undefined : undefined)
  if (!resume || !fs.existsSync(ctx.paths.suiteSnapshotDir)) snapshotSuite(ctx)
  await captureDirtySpecBaseline(ctx)
}
