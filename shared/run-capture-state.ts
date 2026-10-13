import { isTerminalRunStatus, type RunStatus } from './run-state'

export interface RunCaptureInput {
  status: RunStatus
  endedAt?: string
  fixCapture?: { provisional?: boolean }
}

/** Finality alone: callers still validate the captured repos and mutation authority. */
export function deriveRunCaptureState(run: RunCaptureInput): { runStopped: boolean; finalCapture: boolean } {
  const runStopped = isTerminalRunStatus(run.status) && Boolean(run.endedAt)
  return { runStopped, finalCapture: runStopped && run.fixCapture?.provisional !== true }
}
