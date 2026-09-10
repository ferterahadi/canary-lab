/**
 * The one "there is nothing here" rendering.
 *
 * An empty pane is still a state that has to explain itself: what would have
 * been here, why it isn't, and what to do next. A bare muted sentence
 * ("No journal entries for this run.") answers none of those, so every empty
 * surface composes this instead.
 *
 * Two properties make a set of these read as one design rather than as N
 * separately-authored panes, and both are enforced rather than remembered:
 *
 *  1. **The reason is the only variable.** `reason` — not a free `tone` or a
 *     hand-picked glyph — drives the default glyph and the one colour that
 *     appears here. A caller cannot make two panes disagree about what green
 *     means, because it has no colour knob to turn.
 *  2. **Every card is the same height.** The glyph and title lines are fixed;
 *     the body reserves exactly `BODY_LINES` lines; the detail slot is
 *     reserved whether or not it is filled. The copy in `empty-state-copy.ts`
 *     is banded to a character count that always fills those lines and never
 *     overflows them, so the reserved box is both floor and ceiling.
 *
 * Colour is otherwise deliberately absent: an empty state is not a status, and
 * an accent here would read as one. `nothing-to-report` is the single exception
 * — there, "empty" IS the verdict, so it earns `--success`.
 */
import type { ReactNode } from 'react'

/** Why a pane is empty. Four values, because there are only four ways to be:
 *  it hasn't happened yet, it never happened, it happened but the record is
 *  gone, or the emptiness is itself the good news. */
export type EmptyReason = 'not-yet' | 'never-ran' | 'not-captured' | 'nothing-to-report'

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

/** Everything a reason decides. Note what it does NOT decide: a label. The
 *  reason is never printed — a caption reading "NOT CAPTURED" above a title
 *  reading "No service log captured" is the same sentence twice. It governs the
 *  glyph and the single colour, and it makes the author classify the pane before
 *  they can render it; the title is what says the reason out loud. */
export const EMPTY_REASON: Record<EmptyReason, { glyph: ReactNode; success: boolean }> = {
  'not-yet': { glyph: EmptyGlyph.waiting, success: false },
  'never-ran': { glyph: EmptyGlyph.agent, success: false },
  'not-captured': { glyph: EmptyGlyph.agent, success: false },
  'nothing-to-report': { glyph: EmptyGlyph.check, success: true },
}

/** Body geometry. `BODY_WIDTH` and the 12px/`leading-relaxed` body type give
 *  ~59 characters a line, so the 136–140 character band in `empty-state-copy.ts`
 *  wraps to `BODY_LINES` every time — never 2, never 4. Change either number and
 *  `empty-state-copy.test.ts` is the thing that has to be re-derived. */
// `min()`, not a flat width: below ~410px of pane the fixed measure would spill
// out of its own padding. Panes narrower than that trade the shared line count
// for staying inside the box — equal height is a promise about panes seen side
// by side, which is a promise about panes at the same width.
const BODY_WIDTH = 'min(360px, 100%)'
const BODY_LINES = 3
const BODY_FONT_PX = 12
const BODY_LINE_HEIGHT = 1.625
const BODY_MIN_HEIGHT_PX = BODY_FONT_PX * BODY_LINE_HEIGHT * BODY_LINES

/** Reserved even when `detail` is absent, and a fixed height rather than a
 *  minimum: the only content that reaches this slot is a variable server string
 *  (a session-read error, a repair status), which no character band can govern.
 *  One clipped line keeps the card's height an invariant instead of a hope. */
const DETAIL_HEIGHT_PX = 22

export function EmptyState({
  reason,
  icon,
  title,
  body,
  detail,
  testId,
}: {
  reason: EmptyReason
  /** Overrides the reason's default glyph where a surface has a truer mark of
   *  its own (the lifecycle rail, the journal). Never overrides its colour. */
  icon?: ReactNode
  title: string
  body: string
  /** The one optional slot — small print, a path, a link onward. Its height is
   *  reserved whether or not it is used. */
  detail?: ReactNode
  testId?: string
}) {
  const meta = EMPTY_REASON[reason]
  return (
    <div
      data-testid={testId}
      data-empty-reason={reason}
      className="flex h-full min-h-[160px] w-full flex-col items-center justify-center gap-2.5 px-6 py-8 text-center"
    >
      <span
        aria-hidden="true"
        className="flex h-9 w-9 items-center justify-center rounded-lg border"
        style={{
          borderColor: 'var(--border-default)',
          background: 'var(--bg-surface)',
          color: meta.success ? 'var(--success)' : 'var(--border-strong)',
        }}
      >
        {icon ?? meta.glyph}
      </span>
      <div className="text-[13px] font-medium" style={{ color: 'var(--text-secondary)' }}>
        {title}
      </div>
      <p
        className="text-xs leading-relaxed"
        style={{ color: 'var(--text-muted)', width: BODY_WIDTH, minHeight: BODY_MIN_HEIGHT_PX }}
      >
        {body}
      </p>
      <div
        className="flex items-center justify-center gap-2 overflow-hidden text-[11px] leading-relaxed [&>*]:truncate"
        style={{ color: 'var(--text-muted)', height: DETAIL_HEIGHT_PX, width: BODY_WIDTH }}
      >
        {detail}
      </div>
    </div>
  )
}
