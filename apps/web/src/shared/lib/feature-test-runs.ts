import type { RunIndexEntry } from '@shared/run-index'
import { isAuxiliaryExecution } from '@shared/verification'

/** Suite executions, independent of which flight or agent launched them. */
export function featureTestRuns(runs: readonly RunIndexEntry[], feature: string): RunIndexEntry[] {
  return runs.filter((run) => run.feature === feature && !isAuxiliaryExecution(run.executionType))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.runId.localeCompare(a.runId))
}
