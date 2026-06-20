import type { DisplayStatus, ExecutionType } from '../../../api/types'
import { StatusDot, type StatusDotState } from '../../../components/config/atoms'

// Linear-style status indicator: a coloured dot + muted uppercase label.
// Reads as data, not a button. Active states (`running`, `healing`) and
// transient actions (`aborting`, `deleting`, `cancelling-heal`, `pausing`)
// pulse the dot so the user sees the row is in motion.
//
// Accepts a `DisplayStatus`, which is the union of the persisted `RunStatus`
// and the UI-only `TransientAction` values. The transient values are layered
// on top of the persisted status by the caller for the duration of an
// in-flight action — they are never sent to the server.

interface Entry {
  dot: StatusDotState
  /** Tailwind text colour utilities for the label (light + dark). */
  text: string
  pulse?: boolean
  /** Override for the rendered label. Defaults to the status string. */
  label?: string
}

const PALETTE: Record<DisplayStatus, Entry> = {
  queued:  { dot: 'idle',    text: 'text-zinc-600 dark:text-zinc-400', label: 'queued' },
  passed:  { dot: 'success', text: 'text-emerald-700/90 dark:text-emerald-300/90' },
  failed:  { dot: 'failed',  text: 'text-rose-700/90 dark:text-rose-300/90' },
  aborted: { dot: 'idle',    text: 'text-zinc-600 dark:text-zinc-400' },
  running: { dot: 'running', text: 'text-sky-700/90 dark:text-sky-300/90', pulse: true },
  healing: { dot: 'warning', text: 'text-amber-700/90 dark:text-amber-300/90', pulse: true },
  // Transient actions all share the amber pulsing palette so the user reads
  // them as "this row is changing right now". Distinct labels disambiguate.
  aborting:           { dot: 'warning', text: 'text-amber-700/90 dark:text-amber-300/90', pulse: true },
  deleting:           { dot: 'failed',  text: 'text-rose-700/90 dark:text-rose-300/90',   pulse: true },
  'cancelling-heal':  { dot: 'warning', text: 'text-amber-700/90 dark:text-amber-300/90', pulse: true, label: 'cancelling' },
  pausing:            { dot: 'warning', text: 'text-amber-700/90 dark:text-amber-300/90', pulse: true },
}

// Boot-only sessions reuse the same persisted statuses (a held boot run is
// `running`; a stopped one is `aborted`) but read very differently from a test
// run — teal "services up" while held, a neutral "stopped" once torn down — so
// the user never mistakes a held app for a running test suite.
const BOOT_PALETTE: Partial<Record<DisplayStatus, Entry>> = {
  running:  { dot: 'booted', text: 'text-cyan-700/90 dark:text-cyan-300/90', label: 'services up' },
  aborted:  { dot: 'idle',   text: 'text-zinc-600 dark:text-zinc-400',       label: 'stopped' },
  aborting: { dot: 'booted', text: 'text-cyan-700/90 dark:text-cyan-300/90', pulse: true, label: 'stopping' },
}

export function RunStatusIndicator({
  status,
  executionType,
}: {
  status: DisplayStatus
  executionType?: ExecutionType
}) {
  const p = (executionType === 'boot' ? BOOT_PALETTE[status] : undefined)
    ?? PALETTE[status]
    ?? PALETTE.aborted
  return (
    <span
      data-testid="run-status-indicator"
      data-status={status}
      data-mode={executionType === 'boot' ? 'boot' : undefined}
      className={`inline-flex items-center gap-1.5 text-[10px] uppercase tracking-[0.08em] ${p.text}`}
    >
      <StatusDot state={p.dot} pulse={p.pulse} halo={p.pulse} />
      {p.label ?? status}
    </span>
  )
}
