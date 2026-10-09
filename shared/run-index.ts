import type { RunStatus } from './run-state'
import { isAuxiliaryExecution, type ExecutionType, type VerificationRunMetadata } from './verification'

export interface RunIndexEntry {
  runId: string
  executionType?: ExecutionType
  feature: string
  /** The envset this run used, mirrored from the manifest. Spec selection is
   *  constant across envsets, so two runs of one suite declare the SAME roster
   *  and differ only in which tests the environment let execute — 41 passed / 4
   *  skipped under one envset, 4 passed / 41 skipped under another. Without the
   *  envset on the row those read as one run having gone badly. Carried on the
   *  index so the runs list needs no manifest read per row; absent on entries
   *  written before the field existed (backfilled read-time) and on runs that
   *  named no envset. */
  env?: string
  startedAt: string
  status: RunStatus
  endedAt?: string
  /** Repair cycles this run consumed. Mirrored from the manifest on every
   *  index write so a feature's repair total reads off the index alone,
   *  without opening one manifest per run. Absent on pre-existing entries and
   *  on runs that never healed. */
  healCycles?: number
  /** The compact index also carries who owns repair work. Flight Activity
   *  cold-loads terminal runs from this index, while full manifests are sent
   *  only for active runs. */
  healMode?: 'auto' | 'manual' | 'external'
  /** Terminal single-attempt run whose repair still needs a fresh run. */
  newRunRequired?: true
  verificationConfigName?: string
  verificationPlaywrightEnvsetId?: string
  verificationTargetUrls?: Record<string, string>
  /** Live spec edits still pending against this run's suite copy, and the
   *  integrity hints on them — counts only, so `list_runs` can flag a run
   *  without a manifest read. Mirrored on every status write; absent when
   *  zero, and on entries written before the fields existed. */
  pendingSpecEdits?: number
  integrityHints?: number
}

/** Only the fields needed for the index; both manifest types satisfy this
 * without making browser code depend on the server's runtime modules. */
export interface RunIndexSource extends Pick<RunIndexEntry,
  'runId' | 'feature' | 'startedAt' | 'status' | 'executionType' | 'env' | 'endedAt' | 'healCycles' | 'healMode'
> {
  verification?: Pick<VerificationRunMetadata, 'configName' | 'playwrightEnvsetId' | 'targetUrls'>
  healEnd?: { reason: string }
  specEdits?: { pending: readonly unknown[] }
  integrity?: { hints: readonly unknown[] }
}

export function runIndexEntry(manifest: RunIndexSource): RunIndexEntry {
  return {
    runId: manifest.runId,
    ...(manifest.executionType ? { executionType: manifest.executionType } : {}),
    feature: manifest.feature,
    ...(manifest.env ? { env: manifest.env } : {}),
    startedAt: manifest.startedAt,
    status: manifest.status,
    ...(manifest.endedAt ? { endedAt: manifest.endedAt } : {}),
    ...(manifest.healCycles ? { healCycles: manifest.healCycles } : {}),
    ...(manifest.healMode ? { healMode: manifest.healMode } : {}),
    ...(manifest.healEnd?.reason === 'new-run-required' ? { newRunRequired: true as const } : {}),
    ...(manifest.verification?.configName ? { verificationConfigName: manifest.verification.configName } : {}),
    ...(manifest.verification?.playwrightEnvsetId ? { verificationPlaywrightEnvsetId: manifest.verification.playwrightEnvsetId } : {}),
    ...(manifest.verification?.targetUrls ? { verificationTargetUrls: manifest.verification.targetUrls } : {}),
    ...(manifest.specEdits?.pending.length ? { pendingSpecEdits: manifest.specEdits.pending.length } : {}),
    ...(manifest.integrity?.hints.length ? { integrityHints: manifest.integrity.hints.length } : {}),
  }
}

/** A run that can stand as the suite's verdict: a normal test run (not an
 *  auxiliary boot/benchmark/historical cell, and not an observational
 *  `verify` against a deployment) whose status is one of `statuses`. Every
 *  "latest settled / passed run" lookup filters through this one rule; each
 *  caller keeps its own ordering and tie-break. */
export function isSuiteVerdictRun(
  run: Pick<RunIndexEntry, 'executionType' | 'status'>,
  statuses: readonly RunStatus[],
): boolean {
  return !isAuxiliaryExecution(run.executionType)
    && run.executionType !== 'verify'
    && statuses.includes(run.status)
}
