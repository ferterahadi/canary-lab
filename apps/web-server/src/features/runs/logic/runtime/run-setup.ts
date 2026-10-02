import fs from 'fs'
import type { ServiceManifestEntry } from '../../../../../../../shared/run-manifest'
import { claimedSingleAttempt, NEW_RUN_REQUIRED_MESSAGE } from '../../../../shared/single-attempt'
import type { RunContext } from './run-context'
import { readManifest } from './manifest'
import { captureDirtySpecBaseline, prepareRun } from './run-manifest-writer'
import { refreshSpecEdits, snapshotSuite } from './run-suite-snapshot'
import { materializeSuiteRuntimeInputs, prepareSuiteRuntimeInputs } from './suite-runtime-inputs'

/** Both restart entry points need the recorded tests and fresh runtime inputs
 * before an agent or service can run. Local heal still defers service startup
 * until the agent signals; this preparation does not boot anything. */
export async function prepareRunForExecution(ctx: RunContext, serviceStatus: ServiceManifestEntry['status'], resume: boolean): Promise<void> {
  const previous = resume ? readManifest(ctx.paths.manifestPath) : null
  if (claimedSingleAttempt(ctx.runDir, previous?.singleAttempt ?? ctx.feature.singleAttempt)) {
    throw new Error(NEW_RUN_REQUIRED_MESSAGE)
  }
  if (previous?.suiteSnapshot?.kind === 'taken' && !fs.existsSync(ctx.paths.suiteSnapshotDir)) {
    throw new Error('Cannot resume: the recorded suite snapshot is missing. Restore it before continuing this run.')
  }
  prepareRun(ctx, serviceStatus, previous ?? undefined)
  // Resume never replaces retained tests with mutable live source. Runtime
  // inputs are separately owned and recreated after terminal cleanup.
  if (!resume || !fs.existsSync(ctx.paths.suiteSnapshotDir)) snapshotSuite(ctx)
  else {
    prepareSuiteRuntimeInputs(ctx)
    materializeSuiteRuntimeInputs(ctx)
    refreshSpecEdits(ctx, ctx.feature.name)
  }
  await captureDirtySpecBaseline(ctx)
}
