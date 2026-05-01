import type { RunStatus } from '../api/types'

// Linear-style status indicator: a coloured dot + muted uppercase label.
// Replaces the previous bordered "badge" so status reads as data, not as a
// button. Active states (`running`, `healing`) get a subtle ping-pulse on the
// dot to reinforce that the state is live.
//
// Kept as a separate component (not a className helper) so the dot + ping
// markup stays in one place. The deprecated `statusBadgeClass` in
// `lib/format.ts` is preserved for backwards-compat but should not be used
// in new code.

interface PaletteEntry {
  /** Tailwind background utility for the dot, e.g. `bg-rose-500`. */
  dot: string
  /** Tailwind text colour utilities for the label (light + dark). */
  text: string
  /** When true, render an `animate-ping` halo behind the dot. */
  pulse?: boolean
}

const PALETTE: Record<RunStatus, PaletteEntry> = {
  passed:  { dot: 'bg-emerald-500',  text: 'text-emerald-700/90 dark:text-emerald-300/90' },
  failed:  { dot: 'bg-rose-500',     text: 'text-rose-700/90 dark:text-rose-300/90' },
  aborted: { dot: 'bg-zinc-400',     text: 'text-zinc-600 dark:text-zinc-400' },
  running: { dot: 'bg-sky-500',      text: 'text-sky-700/90 dark:text-sky-300/90', pulse: true },
  healing: { dot: 'bg-amber-500',    text: 'text-amber-700/90 dark:text-amber-300/90', pulse: true },
}

export function RunStatusIndicator({ status }: { status: RunStatus }) {
  const p = PALETTE[status] ?? PALETTE.aborted
  return (
    <span
      data-testid="run-status-indicator"
      data-status={status}
      className={`inline-flex items-center gap-1.5 text-[10px] uppercase tracking-[0.08em] ${p.text}`}
    >
      <span className="relative inline-flex h-1.5 w-1.5 items-center justify-center">
        {p.pulse && (
          <span
            data-testid="run-status-pulse"
            className={`absolute inline-flex h-full w-full animate-ping rounded-full ${p.dot} opacity-60`}
          />
        )}
        <span className={`relative inline-flex h-1.5 w-1.5 rounded-full ${p.dot}`} />
      </span>
      {status}
    </span>
  )
}
