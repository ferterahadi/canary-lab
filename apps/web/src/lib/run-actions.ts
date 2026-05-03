import type { DisplayStatus, RunStatus, TransientAction } from '../api/types'

export function canPauseHeal(status: RunStatus): boolean {
  return status === 'running'
}

// Cancel-heal is only valid while the heal agent is actually running.
export function canCancelHeal(status: RunStatus): boolean {
  return status === 'healing'
}

export function canStop(status: RunStatus): boolean {
  return status === 'running' || status === 'healing'
}

// Delete-from-history is only valid once the run has reached a terminal state.
// While the orchestrator is still alive (running/healing), Stop is the right
// action — the run keeps its history so the user can still audit logs.
export function canDelete(status: RunStatus): boolean {
  return status === 'passed' || status === 'failed' || status === 'aborted'
}

// Layer a transient action onto a persisted status for display purposes.
// Returns the transient label when an action is in flight, otherwise the
// underlying RunStatus. Used by the RunsColumn row so the badge reads
// "ABORTING" the moment the user clicks Stop, instead of staying "RUNNING"
// until the server confirms the abort and the next poll lands.
export function deriveDisplayStatus(
  status: RunStatus,
  transient: TransientAction | null,
): DisplayStatus {
  return transient ?? status
}
