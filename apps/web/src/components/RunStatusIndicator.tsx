import type { DisplayStatus } from '../api/types'

// Linear-style status indicator: a coloured dot + muted uppercase label.
// Replaces the previous bordered "badge" so status reads as data, not as a
// button. Active states (`running`, `healing`) and transient actions
// (`aborting`, `deleting`, `cancelling-heal`, `pausing`) get a subtle
// ping-pulse on the dot to reinforce that the state is live.
//
// Accepts a `DisplayStatus`, which is the union of the persisted `RunStatus`
// and the UI-only `TransientAction` values. The transient values are layered
// on top of the persisted status by the caller for the duration of an
// in-flight action — they are never sent to the server.

interface PaletteEntry {
  /** Tailwind background utility for the dot, e.g. `bg-rose-500`. */
  dot: string
  /** Tailwind text colour utilities for the label (light + dark). */
  text: string
  /** When true, render an `animate-ping` halo behind the dot. */
  pulse?: boolean
  /** Optional override for the rendered label. Defaults to the status string. */
  label?: string
}

const PALETTE: Record<DisplayStatus, PaletteEntry> = {
  passed:  { dot: 'bg-emerald-500',  text: 'text-emerald-700/90 dark:text-emerald-300/90' },
  failed:  { dot: 'bg-rose-500',     text: 'text-rose-700/90 dark:text-rose-300/90' },
  aborted: { dot: 'bg-zinc-400',     text: 'text-zinc-600 dark:text-zinc-400' },
  running: { dot: 'bg-sky-500',      text: 'text-sky-700/90 dark:text-sky-300/90', pulse: true },
  healing: { dot: 'bg-amber-500',    text: 'text-amber-700/90 dark:text-amber-300/90', pulse: true },
  // Transient actions all share the amber pulsing palette so the user reads
  // them as "this row is changing right now". Distinct labels disambiguate.
  aborting:           { dot: 'bg-amber-500', text: 'text-amber-700/90 dark:text-amber-300/90', pulse: true },
  deleting:           { dot: 'bg-rose-500',  text: 'text-rose-700/90 dark:text-rose-300/90', pulse: true },
  'cancelling-heal':  { dot: 'bg-amber-500', text: 'text-amber-700/90 dark:text-amber-300/90', pulse: true, label: 'cancelling' },
  pausing:            { dot: 'bg-amber-500', text: 'text-amber-700/90 dark:text-amber-300/90', pulse: true },
}

export function RunStatusIndicator({ status }: { status: DisplayStatus }) {
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
      {p.label ?? status}
    </span>
  )
}
