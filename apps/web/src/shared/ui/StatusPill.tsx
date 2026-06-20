import { StatusDot, type StatusDotState } from '../../features/config/components/atoms'

// Tone of the trailing count badge. Kept small + semantic so every pill in the
// status bar's action cluster reads as a sibling.
export type StatusPillTone = 'neutral' | 'accent' | 'boot'

const COUNT_TONE: Record<StatusPillTone, { bg: string; color: string }> = {
  neutral: { bg: 'var(--bg-selected)', color: 'var(--text-muted)' },
  accent: { bg: 'color-mix(in srgb, var(--accent) 20%, transparent)', color: 'var(--accent)' },
  boot: { bg: 'var(--boot-soft)', color: 'var(--boot)' },
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
  emphasis = false,
  freshPulseKey,
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
  /** Accent border + accent text for an attention state. */
  emphasis?: boolean
  /** When set, renders a one-shot pulse keyed on this value (fresh-arrival cue). */
  freshPulseKey?: string | number
  onClick: () => void
  title?: string
  ariaLabel?: string
}) {
  const hasDetail = Boolean(detail)
  const hasPulse = freshPulseKey != null
  const className =
    `cl-button flex shrink-0 items-center gap-1.5 px-2.5 py-1${hasDetail ? ' min-w-0 max-w-[200px]' : ''}${hasPulse ? ' relative' : ''}`
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={ariaLabel}
      className={className}
      style={
        emphasis
          ? { color: 'var(--accent)', borderColor: 'color-mix(in srgb, var(--accent) 45%, var(--border-default))' }
          : undefined
      }
    >
      {hasPulse && <span key={`pill-pulse-${freshPulseKey}`} aria-hidden="true" className="cl-boot-pill-pulse" />}
      <StatusDot state={dotState} className="shrink-0" />
      <span
        className="shrink-0"
        style={{ fontSize: 12, fontWeight: 500, color: emphasis ? 'var(--accent)' : 'var(--text-primary)' }}
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
          className="inline-flex min-w-[16px] shrink-0 items-center justify-center rounded-full px-1 text-[10px] font-semibold"
          style={{ background: COUNT_TONE[countTone].bg, color: COUNT_TONE[countTone].color }}
        >
          {count}
        </span>
      )}
    </button>
  )
}
