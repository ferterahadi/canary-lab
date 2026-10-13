import type { ExecutionType } from '../../shared/verification'
import type { RunStatus, TransientAction } from '../../shared/run-state'

export const runActionStatuses: RunStatus[] = ['queued', 'running', 'healing', 'passed', 'failed', 'aborted']
export const runActionTypes: Array<ExecutionType | undefined> = [undefined, 'run', 'verify', 'boot', 'benchmark', 'robustness']
export const runActionTransients: Array<TransientAction | null> = [null, 'pausing', 'aborting', 'cancelling-heal', 'deleting']
