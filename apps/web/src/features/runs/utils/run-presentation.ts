import type { DisplayStatus, ExecutionType } from '@/shared/api/types'
import type { StatusDotState } from '@/shared/ui/atoms'
import type { RunWaitingState } from './run-waiting-state'

export interface RunPresentation {
  label: string
  /** Space reserved by compact suite and Flight chips for qualified waits. */
  chipWidth?: number
  title: string
  tone: string
  background: string
  dot: StatusDotState
  pulse: boolean
}

const RUN_PRESENTATION: Record<DisplayStatus, RunPresentation> = {
  queued: { label: 'Queued', title: 'Waiting to start', tone: 'var(--text-secondary)', background: 'var(--bg-selected)', dot: 'idle', pulse: false },
  running: { label: 'Running', title: 'Run in progress', tone: 'var(--running)', background: 'color-mix(in srgb, var(--running) 15%, transparent)', dot: 'running', pulse: true },
  healing: { label: 'Healing', title: 'A repair agent is fixing the app so the failing tests pass', tone: 'var(--warning)', background: 'color-mix(in srgb, var(--warning) 15%, transparent)', dot: 'warning', pulse: true },
  passed: { label: 'Passed', title: 'Run passed', tone: 'var(--success)', background: 'color-mix(in srgb, var(--success) 15%, transparent)', dot: 'success', pulse: false },
  failed: { label: 'Failed', title: 'Run failed', tone: 'var(--danger)', background: 'color-mix(in srgb, var(--danger) 15%, transparent)', dot: 'failed', pulse: false },
  aborted: { label: 'Aborted', title: 'Run aborted', tone: 'var(--text-muted)', background: 'var(--bg-selected)', dot: 'idle', pulse: false },
  aborting: { label: 'Aborting', title: 'Stopping this run', tone: 'var(--warning)', background: 'color-mix(in srgb, var(--warning) 15%, transparent)', dot: 'warning', pulse: true },
  deleting: { label: 'Deleting', title: 'Deleting this run', tone: 'var(--danger)', background: 'color-mix(in srgb, var(--danger) 15%, transparent)', dot: 'failed', pulse: true },
  'cancelling-heal': { label: 'Cancelling', title: 'Stopping repair', tone: 'var(--warning)', background: 'color-mix(in srgb, var(--warning) 15%, transparent)', dot: 'warning', pulse: true },
  pausing: { label: 'Pausing', title: 'Pausing this run', tone: 'var(--warning)', background: 'color-mix(in srgb, var(--warning) 15%, transparent)', dot: 'warning', pulse: true },
}

const BOOT_PRESENTATION: Partial<Record<DisplayStatus, RunPresentation>> = {
  running: { label: 'Services up', title: 'Boot session is holding services open', tone: 'var(--boot)', background: 'var(--boot-soft)', dot: 'booted', pulse: true },
  aborted: { label: 'Stopped', title: 'Boot session stopped', tone: 'var(--text-muted)', background: 'var(--bg-selected)', dot: 'idle', pulse: false },
  aborting: { label: 'Stopping', title: 'Stopping boot session', tone: 'var(--boot)', background: 'var(--boot-soft)', dot: 'booted', pulse: true },
}

/** The display contract for one run, independent of the surface rendering it. */
export function presentRunStatus({ status, executionType, waiting }: {
  status: DisplayStatus
  executionType?: ExecutionType | null
  waiting?: RunWaitingState
}): RunPresentation {
  const base = (executionType === 'boot' ? BOOT_PRESENTATION[status] : undefined) ?? RUN_PRESENTATION[status]
  if (!waiting || executionType === 'boot' || status !== 'healing' && status !== 'queued') return base
  const queued = waiting.kind === 'queued'
  return {
    label: waiting.label,
    chipWidth: queued ? undefined : waiting.kind === 'test-review' ? 136 : 120,
    title: waiting.detail,
    tone: queued ? 'var(--text-muted)' : 'var(--warning)',
    background: queued ? 'var(--bg-selected)' : 'color-mix(in srgb, var(--warning) 15%, transparent)',
    dot: queued ? 'idle' : 'warning',
    pulse: false,
  }
}
