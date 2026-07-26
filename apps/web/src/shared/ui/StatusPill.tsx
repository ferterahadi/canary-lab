import type { ReactNode } from 'react'
import { StatusDot, type StatusDotState } from '@/features/config/components/atoms'

// Tone of the trailing count badge. Kept small + semantic so every pill in the
// status bar's action cluster reads as a sibling.
export type StatusPillTone = 'neutral' | 'accent' | 'boot' | 'danger'

const COUNT_TONE: Record<StatusPillTone, { bg: string; color: string }> = {
  neutral: { bg: 'var(--bg-selected)', color: 'var(--text-muted)' },
  accent: { bg: 'color-mix(in srgb, var(--accent) 20%, transparent)', color: 'var(--accent)' },
  boot: { bg: 'var(--boot-soft)', color: 'var(--boot)' },
  danger: { bg: 'color-mix(in srgb, var(--danger) 20%, transparent)', color: 'var(--danger)' },
}

// Emphasis (border + name text) colour. Accent for attention (Portify
// ready-to-commit), danger for an integrity warning (modified test files).
const EMPHASIS_COLOR: Record<'accent' | 'danger', string> = {
  accent: 'var(--accent)',
  danger: 'var(--danger)',
}

// The single, standardized status-bar pill. One anatomy for every action /
// task chip in the GlobalStatusBar cluster:
//
//   [StatusDot] [name] [· detail — muted, truncates, xl+ only] [count badge]
//
// State is carried by the StatusDot; `emphasis` reserves an accent border+text
// for an attention state (e.g. Portify ready-to-commit). Callers stay
// presentational — they map their domain status to these props.
export function StatusPill({
  dotState,
  name,
  detail,
  count,
  countTone = 'neutral',
  countColor,
  countTestId,
  emphasis = false,
  emphasisTone = 'accent',
  emphasisColor,
  freshPulseKey,
  icon,
  overlayDot = false,
  ariaExpanded,
  onClick,
  title,
  ariaLabel,
}: {
  dotState: StatusDotState
  name: string
  /** Muted secondary text. Truncates and only shows at xl+ to keep the bar tight. */
  detail?: string
  /** Trailing count badge. Pass `undefined` to omit it entirely. */
  count?: number
  countTone?: StatusPillTone
  /** An arbitrary CSS colour for the count badge, overriding `countTone` — for a
   *  caller whose count should track its own dynamic tone (e.g. mirroring
   *  `emphasisColor`) rather than one of the fixed semantic tones. */
  countColor?: string
  /** `data-testid` for the count badge, when a caller's tests target it directly. */
  countTestId?: string
  /** Coloured border + name text for an attention state. */
  emphasis?: boolean
  /** Which colour `emphasis` uses — accent (default) or danger (integrity warning). */
  emphasisTone?: 'accent' | 'danger'
  /** An arbitrary CSS colour for `emphasis`, overriding `emphasisTone` — for a
   *  caller whose attention states span more than accent/danger (e.g. a status
   *  palette keyed per lifecycle state). */
  emphasisColor?: string
  /** When set, renders a one-shot pulse keyed on this value (fresh-arrival cue). */
  freshPulseKey?: string | number
  /** Replace the default `StatusDot` with a custom leading glyph — for a pill
   *  whose idle state isn't well served by a plain status dot (e.g. a launcher
   *  icon shown only when nothing is active). */
  icon?: ReactNode
  /** Small attention dot pinned to the pill's top-right corner — independent of
   *  `count`/`emphasis`, for "something here needs a human" regardless of tone. */
  overlayDot?: boolean
  /** Pass through when the pill is a disclosure trigger for a picker/menu. */
  ariaExpanded?: boolean
  onClick: () => void
  title?: string
  ariaLabel?: string
}) {
  const hasDetail = Boolean(detail)
  const hasPulse = freshPulseKey != null
  const resolvedEmphasisColor = emphasisColor ?? EMPHASIS_COLOR[emphasisTone]
  const className =
    `cl-button flex shrink-0 items-center gap-1.5 px-2.5 py-1${hasDetail ? ' min-w-0 max-w-[200px]' : ''}${hasPulse || overlayDot ? ' relative' : ''}`
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={ariaLabel}
      aria-expanded={ariaExpanded}
      className={className}
      style={
        emphasis
          ? {
              color: resolvedEmphasisColor,
              borderColor: `color-mix(in srgb, ${resolvedEmphasisColor} 45%, var(--border-default))`,
            }
          : undefined
      }
    >
      {hasPulse && <span key={`pill-pulse-${freshPulseKey}`} aria-hidden="true" className="cl-boot-pill-pulse" />}
      {overlayDot && (
        <span
          aria-hidden="true"
          className="absolute -right-1 -top-1 h-[6px] w-[6px] rounded-full"
          style={{ background: 'var(--warning)', boxShadow: '0 0 6px color-mix(in srgb, var(--warning) 70%, transparent)' }}
        />
      )}
      {icon ?? <StatusDot state={dotState} className="shrink-0" />}
      <span
        className="shrink-0"
        style={{ fontSize: 12, fontWeight: 500, color: emphasis ? resolvedEmphasisColor : 'var(--text-primary)' }}
      >
        {name}
      </span>
      {hasDetail && (
        <span className="hidden min-w-0 truncate text-[11px] xl:inline" style={{ color: 'var(--text-muted)' }}>
          {detail}
        </span>
      )}
      {typeof count === 'number' && (
        <span
          data-testid={countTestId}
          className="inline-flex min-w-[16px] shrink-0 items-center justify-center rounded-full px-1 text-[10px] font-semibold"
          style={
            countColor
              ? { background: `color-mix(in srgb, ${countColor} 18%, transparent)`, color: countColor }
              : { background: COUNT_TONE[countTone].bg, color: COUNT_TONE[countTone].color }
          }
        >
          {count}
        </span>
      )}
    </button>
  )
}
