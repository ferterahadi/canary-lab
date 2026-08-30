import type { CSSProperties, ReactNode } from 'react'
import { StatusDot, type StatusDotState } from './atoms'

/** The shared non-interactive status badge — the small core behind every
 *  read-only "coloured dot/icon + label" chip in the app (`StatusChip`,
 *  `ConnectionBadge`, `RunStatusChip`, `StageStatusChip`, `FlightStatusChip`).
 *  Each of those had drifted into its own hand-rolled `<span>`/`<div>` with the
 *  same shape — this is the one home; callers keep their own tone/label
 *  mapping and pass the rendered result in. (`StatusPill` stays separate: it's
 *  a clickable action pill with a count badge, a different interaction model.) */
export function Chip({
  tone,
  labelColor,
  background,
  chrome = 'none',
  icon,
  label,
  detail,
  uppercase = false,
  fontSize = 10.5,
  fontWeight = 500,
  width,
  testId,
  title,
  onClick,
  expanded,
}: {
  /** CSS colour driving the border (chrome="border" falls back to a neutral
   *  `--border-default` frame without it) and, unless overridden by
   *  `labelColor`, the label text. */
  tone?: string
  /** Explicit label colour, overriding the `tone` default (and `chrome="none"`'s
   *  text-primary default) — for a chip like `StatusChip` whose label stays a
   *  fixed colour regardless of state. */
  labelColor?: string
  /** Explicit fill colour for chrome="fill", overriding the `tone`-derived tint
   *  — some fill chips use a flat neutral background for their resting state
   *  (e.g. queued/aborted) rather than a tinted one. */
  background?: string
  chrome?: 'none' | 'fill' | 'border'
  /** Leading glyph — typically a `StatusDot`, sometimes a plain character. */
  icon?: ReactNode
  label: ReactNode
  /** Trailing muted detail text, rendered smaller. */
  detail?: string
  uppercase?: boolean
  fontSize?: number
  fontWeight?: number
  /** Fixed width (px) for column-aligned chips — truncates the label instead
   *  of letting it grow. */
  width?: number
  testId?: string
  title?: string
  /** Makes the chip a button — identical shape, plus a pointer and hover
   *  feedback. For a chip that OPENS something (the stage's model plan) rather
   *  than only reporting; without it the chip stays the inert span it was. */
  onClick?: () => void
  /** Set alongside `onClick` when the button opens a popover, so the trigger
   *  announces the panel it owns. */
  expanded?: boolean
}) {
  const resolvedLabelColor = labelColor ?? tone ?? 'var(--text-primary)'
  const shapeClass =
    chrome === 'fill' ? 'rounded-full px-2 py-0.5'
    : chrome === 'border' ? 'rounded-md px-2 py-0.5'
    : ''
  const style: CSSProperties = {
    color: resolvedLabelColor,
    fontSize,
    fontWeight,
    ...(uppercase ? { textTransform: 'uppercase', letterSpacing: '0.025em' } : {}),
    ...(chrome === 'fill'
      ? { background: background ?? (tone ? `color-mix(in srgb, ${tone} 15%, transparent)` : undefined) }
      : {}),
    ...(chrome === 'border'
      ? { border: tone ? `1px solid color-mix(in srgb, ${tone} 35%, transparent)` : '1px solid var(--border-default)' }
      : {}),
    ...(width
      ? { width, justifyContent: 'center', textAlign: 'center', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
      : {}),
  }
  const body = (
    <>
      {icon}
      <span className={width ? 'truncate' : undefined}>{label}</span>
      {detail && (
        <span style={{ color: 'var(--text-muted)', fontSize: 11, fontWeight: 400 }}>
          {detail}
        </span>
      )}
    </>
  )
  const className = `inline-flex shrink-0 items-center gap-1.5 ${shapeClass}`.trim()
  if (onClick) {
    return (
      <button
        type="button"
        data-testid={testId}
        title={title}
        aria-haspopup={expanded === undefined ? undefined : 'dialog'}
        aria-expanded={expanded}
        onClick={onClick}
        className={`${className} cursor-pointer transition-colors duration-150 hover:brightness-125`}
        style={style}
      >
        {body}
      </button>
    )
  }
  return (
    <span data-testid={testId} title={title} className={className} style={style}>
      {body}
    </span>
  )
}

// Labelled status chip: a semantic dot + label + state word. Used in the status
// bar for the active run's service count.
export function StatusChip({ label, state }: { label: string; state: 'running' | 'healing' | 'idle' }) {
  const dotState: StatusDotState =
    state === 'running' ? 'success'
    : state === 'healing' ? 'warning'
    : 'idle'
  return (
    <Chip
      icon={<StatusDot state={dotState} pulse={state !== 'idle'} halo={state !== 'idle'} />}
      label={label}
      detail={state}
      fontSize={11.5}
      fontWeight={500}
    />
  )
}
