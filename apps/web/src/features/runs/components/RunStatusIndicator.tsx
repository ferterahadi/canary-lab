import type { DisplayStatus, ExecutionType } from '@/shared/api/types'
import { StatusDot } from '@/shared/ui/atoms'
import { presentRunStatus } from '../utils/run-presentation'
import type { RunWaitingState } from '../utils/run-waiting-state'

// Linear-style status indicator: a coloured dot + muted uppercase label.
// Reads as data, not a button. Active states (`running`, `healing`) and
// transient actions (`aborting`, `deleting`, `cancelling-heal`, `pausing`)
// pulse the dot so the user sees the row is in motion.
//
// Accepts a `DisplayStatus`, which is the union of the persisted `RunStatus`
// and the UI-only `TransientAction` values. The transient values are layered
// on top of the persisted status by the caller for the duration of an
// in-flight action — they are never sent to the server.

export function RunStatusIndicator({
  status,
  executionType,
  waiting,
}: {
  status: DisplayStatus
  executionType?: ExecutionType
  waiting?: RunWaitingState
}) {
  const p = presentRunStatus({ status, executionType, waiting })
  return (
    <span
      data-testid="run-status-indicator"
      data-status={status}
      data-mode={executionType === 'boot' ? 'boot' : undefined}
      title={p.title}
      className="inline-flex items-center gap-1.5 text-[10px] uppercase tracking-[0.08em]"
      style={{ color: p.tone }}
    >
      <StatusDot state={p.dot} pulse={p.pulse} halo={p.pulse && p.dot !== 'booted'} />
      {p.label}
    </span>
  )
}
