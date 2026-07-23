import type { ExecutionType, RunDetail, RunIndexEntry, RunStatus } from '../../../shared/api/types'
import { StatusDot, type StatusDotState } from '../../config/components/atoms'
import { Chip } from '../../../shared/ui/StatusChip'
import { shortTime } from '../../../shared/lib/format'

// One run row + its status chip, extracted verbatim from RunsListDialog (R64)
// so the flight's run stage can render the same row as the runs list. Chrome
// mirrors the EvaluationExportTaskToast / WizardTaskStatus dialogs (leading
// status dot + pill chip) so run/task surfaces read as one family.

// Pill chip palettes, keyed by run status. Colour families match
// RunStatusIndicator / WizardTaskStatus so the surfaces stay in sync.
const CHIP: Record<RunStatus, { bg: string; text: string }> = {
  running: { bg: 'color-mix(in srgb, var(--running) 15%, transparent)', text: 'var(--running)' },
  healing: { bg: 'color-mix(in srgb, var(--warning) 15%, transparent)', text: 'var(--warning)' },
  queued:  { bg: 'var(--bg-selected)', text: 'var(--text-secondary)' },
  passed:  { bg: 'color-mix(in srgb, var(--success) 15%, transparent)', text: 'var(--success)' },
  failed:  { bg: 'color-mix(in srgb, var(--danger) 15%, transparent)', text: 'var(--danger)' },
  aborted: { bg: 'var(--bg-selected)', text: 'var(--text-muted)' },
}

const DOT: Record<RunStatus, { state: StatusDotState; pulse: boolean }> = {
  running: { state: 'running', pulse: true },
  healing: { state: 'warning', pulse: true },
  queued:  { state: 'idle', pulse: false },
  passed:  { state: 'success', pulse: false },
  failed:  { state: 'failed', pulse: false },
  aborted: { state: 'idle', pulse: false },
}

function portsLabel(detail: RunDetail | undefined): string | null {
  const ports = (detail?.manifest.services ?? [])
    .flatMap((s) => Object.values(s.allocatedPorts ?? {}))
  return ports.length > 0 ? ports.map((p) => `:${p}`).join(' ') : null
}

function queueNote(entry: RunIndexEntry, detail: RunDetail | undefined): string | null {
  if (entry.status !== 'queued') return null
  const reason = detail?.manifest.queueReason
  if (reason === 'repo-collision') return 'waiting for the same app to finish'
  if (reason === 'resources') return 'waiting for resources'
  return 'queued'
}

export function RunRow({
  run,
  detail,
  onSelect,
}: {
  run: RunIndexEntry
  detail: RunDetail | undefined
  onSelect: (run: RunIndexEntry) => void
}) {
  const ports = portsLabel(detail)
  const note = queueNote(run, detail)
  // A held boot session is status 'running' but reads as teal "services up".
  const isBoot = run.executionType === 'boot'
  const dot = isBoot && run.status === 'running' ? { state: 'booted' as const, pulse: true } : DOT[run.status]
  const meta: Array<{ text: string; mono?: boolean }> = [{ text: shortTime(run.startedAt) }]
  if (ports) meta.push({ text: ports, mono: true })
  if (note) meta.push({ text: note })
  const summary = detail?.summary
  if (summary && summary.total > 0) meta.push({ text: `${summary.passed}/${summary.total} passed` })
  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(run)}
        className="group flex w-full items-center gap-2 rounded-md px-3 py-2 text-left cl-hover-row"
        title={`Go to run ${run.runId}`}
      >
        <StatusDot state={dot.state} pulse={dot.pulse} halo={dot.pulse} className="shrink-0" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[13px]" style={{ color: 'var(--text-primary)', fontWeight: 500 }}>
            {run.feature}
          </span>
          <span className="mt-0.5 flex min-w-0 items-center gap-1.5 truncate text-[11px]" style={{ color: 'var(--text-muted)' }}>
            {meta.map((part, i) => (
              <span key={i} className="flex min-w-0 items-center gap-1.5">
                {i > 0 && <Sep />}
                <span
                  className={part.mono ? 'shrink-0' : 'truncate'}
                  style={part.mono ? { fontFamily: 'var(--font-mono)' } : undefined}
                >
                  {part.text}
                </span>
              </span>
            ))}
          </span>
        </span>
        <RunStatusChip status={run.status} executionType={run.executionType} />
        <span
          className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
          style={{ color: 'var(--accent)' }}
          aria-hidden="true"
        >
          →
        </span>
      </button>
    </li>
  )
}

export function RunStatusChip({ status, executionType }: { status: RunStatus; executionType?: ExecutionType }) {
  const boot = executionType === 'boot' && (status === 'running' || status === 'aborted')
  const palette = boot
    ? (status === 'running'
        ? { bg: 'var(--boot-soft)', text: 'var(--boot)' }
        : { bg: 'var(--bg-selected)', text: 'var(--text-muted)' })
    : CHIP[status]
  const label = boot ? (status === 'running' ? 'services up' : 'stopped') : status
  return (
    <Chip
      chrome="fill"
      tone={palette.text}
      background={palette.bg}
      label={label}
      uppercase
      fontSize={10}
      fontWeight={600}
    />
  )
}

function Sep() {
  return (
    <span aria-hidden="true" className="select-none" style={{ color: 'var(--text-muted)', opacity: 0.5 }}>
      ·
    </span>
  )
}
