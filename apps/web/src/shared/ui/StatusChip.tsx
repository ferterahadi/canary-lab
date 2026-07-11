import type { CSSProperties, ReactNode } from 'react'
import { StatusDot, type StatusDotState } from '../../features/config/components/atoms'

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
}: {
  /** CSS colour driving the border (chrome="border") and, unless overridden by
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
}) {
  const resolvedLabelColor = labelColor ?? tone ?? 'var(--text-primary)'
  const shapeClass =
    chrome === 'fill' ? 'rounded-full px-2 py-0.5'
    : chrome === 'border' ? 'rounded px-1.5 py-0.5'
    : ''
  const style: CSSProperties = {
    color: resolvedLabelColor,
    fontSize,
    fontWeight,
    ...(uppercase ? { textTransform: 'uppercase', letterSpacing: '0.025em' } : {}),
    ...(chrome === 'fill'
      ? { background: background ?? (tone ? `color-mix(in srgb, ${tone} 15%, transparent)` : undefined) }
      : {}),
    ...(chrome === 'border' && tone
      ? { border: `1px solid color-mix(in srgb, ${tone} 35%, transparent)` }
      : {}),
    ...(width
      ? { width, justifyContent: 'center', textAlign: 'center', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
      : {}),
  }
  return (
    <span
      data-testid={testId}
      title={title}
      className={`inline-flex shrink-0 items-center gap-1.5 ${shapeClass}`.trim()}
      style={style}
    >
      {icon}
      <span className={width ? 'truncate' : undefined}>{label}</span>
      {detail && (
        <span style={{ color: 'var(--text-muted)', fontSize: 11, fontWeight: 400 }}>
          {detail}
        </span>
      )}
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
