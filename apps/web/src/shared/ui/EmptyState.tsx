/**
 * The one "there is nothing here" rendering.
 *
 * An empty pane is still a state that has to explain itself: what would have
 * been here, why it isn't, and what to do next. A bare muted sentence
 * ("No journal entries for this run.") answers none of those, so every empty
 * surface composes this instead — a quiet framed glyph, a title, one line of
 * body, and an optional action or footnote.
 *
 * The glyph is drawn in `--border-strong` rather than an accent: an empty state
 * is not a status, and colour here would read as one.
 */
import type { ReactNode } from 'react'

export type EmptyStateTone = 'neutral' | 'good'

export function EmptyState({
  icon,
  title,
  body,
  footnote,
  action,
  tone = 'neutral',
  testId,
}: {
  /** 20×20 stroke SVG — use one of the `EmptyGlyph.*` set below. */
  icon?: ReactNode
  title: string
  body?: string
  /** Small print under the body — a path, a hint, a "this is expected". */
  footnote?: ReactNode
  action?: ReactNode
  /** `good` tints the glyph success-green for "empty because nothing went wrong". */
  tone?: EmptyStateTone
  testId?: string
}) {
  const glyphColor = tone === 'good' ? 'var(--success)' : 'var(--border-strong)'
  return (
    <div
      data-testid={testId}
      className="flex h-full min-h-[160px] w-full flex-col items-center justify-center gap-2.5 px-6 py-8 text-center"
    >
      {icon && (
        <span
          aria-hidden="true"
          className="flex h-9 w-9 items-center justify-center rounded-lg border"
          style={{
            borderColor: 'var(--border-default)',
            background: 'var(--bg-surface)',
            color: glyphColor,
          }}
        >
          {icon}
        </span>
      )}
      <div className="text-[13px] font-medium" style={{ color: 'var(--text-secondary)' }}>
        {title}
      </div>
      {body && (
        <p className="max-w-[360px] text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
          {body}
        </p>
      )}
      {footnote && (
        <div className="max-w-[360px] text-[11px] leading-relaxed" style={{ color: 'var(--text-muted)', opacity: 0.85 }}>
          {footnote}
        </div>
      )}
      {action && <div className="mt-1 flex items-center gap-2">{action}</div>}
    </div>
  )
}

const GLYPH_PROPS = {
  width: 18,
  height: 18,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
} as const

/** The empty-state glyph set. Kept together so surfaces don't each invent one. */
export const EmptyGlyph = {
  journal: (
    <svg {...GLYPH_PROPS}>
      <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H19v16H5.5A1.5 1.5 0 0 1 4 18.5z" />
      <path d="M8 8.5h7M8 12h7M8 15.5h4" />
    </svg>
  ),
  // Deliberately the same prompt-in-a-frame mark as `PaneTerminal`'s
  // placeholder, so "an agent would have run here" reads the same whether the
  // surface is an xterm pane or the structured timeline.
  agent: (
    <svg {...GLYPH_PROPS}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M7 9l3 3-3 3" />
      <path d="M13 15h4" />
    </svg>
  ),
  check: (
    <svg {...GLYPH_PROPS}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="m8.5 12 2.5 2.5 4.5-5" />
    </svg>
  ),
  timeline: (
    <svg {...GLYPH_PROPS}>
      <path d="M6 4v16" />
      <circle cx="6" cy="8" r="1.8" />
      <circle cx="6" cy="16" r="1.8" />
      <path d="M11 8h8M11 16h6" />
    </svg>
  ),
  waiting: (
    <svg {...GLYPH_PROPS}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 1.8" />
    </svg>
  ),
} as const
