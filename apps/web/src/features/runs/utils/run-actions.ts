import {
  deriveRunActionAvailability,
  isTerminalRunStatus,
  type RunStatus,
} from '../../../../../../shared/run-state'

export function canPauseHeal(status: RunStatus): boolean {
  return deriveRunActionAvailability(status).pauseHeal.enabled
}

// Cancel-heal is only valid while the heal agent is actually running.
export function canCancelHeal(status: RunStatus): boolean {
  return deriveRunActionAvailability(status).cancelHeal.enabled
}

export function canStop(status: RunStatus): boolean {
  return deriveRunActionAvailability(status).stop.enabled
}

// Delete-from-history is only valid once the run has reached a terminal state.
// While the orchestrator is still alive (running/healing), the run must finish
// or be stopped/cancelled before deletion so the user can still audit logs.
export function canDelete(status: RunStatus): boolean {
  return isTerminalRunStatus(status)
}

export { deriveDisplayStatus } from '../../../../../../shared/run-state'
export type { DisplayStatus, TransientAction } from '../../../../../../shared/run-state'
