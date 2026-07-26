import type { ExecutionType, RunDetail, RunIndexEntry, RunStatus } from '@/shared/api/types'
import { StatusDot, type StatusDotState } from '@/features/config/components/atoms'
import { Chip } from '@/shared/ui/StatusChip'
import { shortTime } from '@/shared/lib/format'

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
  primaryLabel,
  marker,
  showPorts = true,
  passCount = 'meta',
  arrow = 'hover',
}: {
  run: RunIndexEntry
  detail: RunDetail | undefined
  onSelect: (run: RunIndexEntry) => void
  /** Override the bold identity line (default `run.feature`). The Test Run
   *  hero passes "Run <ref>" so the run reads as an object, not a feature row. */
  primaryLabel?: string
  /** Extra trailing meta segment (e.g. "run 2 of 2") — the hero's ordinal. */
  marker?: string
  /** Show the allocated-ports meta segment. The hero hides it (ports belong on
   *  the Services tile's tooltip, not the identity line). */
  showPorts?: boolean
  /** Where the pass count goes. 'meta' (default) puts it in the meta line with
   *  the timestamp; 'promoted' gives it its own segment beside the status chip.
   *  'hidden' drops it — for a surface that already states the score bigger
   *  elsewhere (the flight run stage's Tests-passed tile), where repeating it a
   *  hand's width away just reads as two different facts. */
  passCount?: 'meta' | 'promoted' | 'hidden'
  /** When the trailing `→` shows. Default 'hover' (the runs list, where rows are
   *  scanned in bulk and a column of arrows would be noise). 'always' is for a
   *  short list whose whole point is going somewhere — the flight run stage's
   *  Previous runs — so the affordance reads at rest. */
  arrow?: 'hover' | 'always'
}) {
  const ports = showPorts ? portsLabel(detail) : null
  const note = queueNote(run, detail)
  // A held boot session is status 'running' but reads as teal "services up".
  const isBoot = run.executionType === 'boot'
  const dot = isBoot && run.status === 'running' ? { state: 'booted' as const, pulse: true } : DOT[run.status]
  const meta: Array<{ text: string; mono?: boolean }> = [{ text: shortTime(run.startedAt) }]
  if (ports) meta.push({ text: ports, mono: true })
  if (note) meta.push({ text: note })
  if (marker) meta.push({ text: marker })
  const summary = detail?.summary
  const passLabel = summary && summary.total > 0 ? `${summary.passed}/${summary.total} passed` : null
  if (passLabel && passCount === 'meta') meta.push({ text: passLabel })
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
            {primaryLabel ?? run.feature}
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
        {passCount === 'promoted' && passLabel && (
          <span
            className="shrink-0 text-[11px] tabular-nums"
            style={{ color: 'var(--text-secondary)' }}
          >
            {passLabel}
          </span>
        )}
        <RunStatusChip status={run.status} executionType={run.executionType} />
        <span
          className={`shrink-0 transition-opacity ${arrow === 'always' ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}
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
