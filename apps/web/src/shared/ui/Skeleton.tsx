import { PanelCard } from './PanelCard'

// R83 — the one placeholder vocabulary. A stage pane keeps the layout its
// SETTLED state has, in every state: each card that a finished stage shows is
// rendered here as its own shape with the figures replaced by bars, so a value
// lands in the slot its placeholder held instead of pushing the pane around
// when the stage finishes.
//
// The BAR is what says "not measured yet". The sweep only adds "and something is
// working on it right now" — a split that matters because the headless preview
// forces reduced-motion, so a viewer with no animation must still read a
// placeholder rather than a blank card.

/** Why a card is showing placeholders: `live` (a stage is working on it, so the
 *  bars sweep) or `idle` (pending, paused, failed — nothing is coming until the
 *  user acts, so they stand still). Absent means "not awaiting anything", which
 *  is how a settled stage keeps its `return null` for a card it genuinely has
 *  no content for. */
export type AwaitingState = 'live' | 'idle'

/** The pane's awaiting state, from the stage's own status. One home so every
 *  panel is told the same thing: a settled stage has produced everything it ever
 *  will, and must never render a placeholder promising more. */
export function awaitingFor(status: string, live: boolean): AwaitingState | undefined {
  if (status === 'done' || status === 'skipped') return undefined
  return live ? 'live' : 'idle'
}

/** One placeholder bar. Widths are given per site rather than randomized —
 *  `Math.random` would reshuffle the card on every render, which reads as
 *  activity that isn't happening. */
export function SkeletonBar({ awaiting, width = '62%', height = 10, className = '' }: {
  awaiting: AwaitingState
  width?: string
  height?: number
  className?: string
}) {
  return (
    <span
      aria-hidden
      data-testid="skeleton-bar"
      className={`block rounded-full${awaiting === 'live' ? ' cl-skeleton' : ''}${className ? ` ${className}` : ''}`}
      style={{ width, height, background: 'var(--border-strong)' }}
    />
  )
}

/** Deterministic width cycle: consecutive bars differ enough to read as text
 *  rather than as a progress bar, and the same row always gets the same width. */
const LINE_WIDTHS = ['78%', '54%', '67%', '43%'] as const

/** A block of text-shaped bars — the stand-in for a card's body copy. */
export function SkeletonLines({ awaiting, rows = 2, height = 9 }: {
  awaiting: AwaitingState
  rows?: number
  height?: number
}) {
  return (
    <div className="flex flex-col gap-1.5" data-testid="skeleton-lines">
      {Array.from({ length: rows }, (_, i) => (
        <SkeletonBar key={i} awaiting={awaiting} width={LINE_WIDTHS[i % LINE_WIDTHS.length]} height={height} />
      ))}
    </div>
  )
}

/** A list row's shape: the leading indicator every row-list on a stage carries
 *  (StepList's bead, RunRow's status dot) plus a title bar and a quieter
 *  sub-line, so a skeleton list reads as the list it will become. */
export function SkeletonRow({ awaiting, sub = true }: { awaiting: AwaitingState; sub?: boolean }) {
  return (
    <li className="flex items-start gap-2.5 py-1.5" data-testid="skeleton-row">
      <span
        aria-hidden
        className="mt-[3px] h-[9px] w-[9px] shrink-0 rounded-full border"
        style={{ borderColor: 'var(--border-strong)' }}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <SkeletonBar awaiting={awaiting} width="46%" height={9} />
        {sub && <SkeletonBar awaiting={awaiting} width="72%" height={7} />}
      </div>
    </li>
  )
}

export function SkeletonRows({ awaiting, rows = 2, sub = true }: {
  awaiting: AwaitingState
  rows?: number
  sub?: boolean
}) {
  return (
    <ul className="m-0 flex list-none flex-col p-0">
      {Array.from({ length: rows }, (_, i) => <SkeletonRow key={i} awaiting={awaiting} sub={sub} />)}
    </ul>
  )
}

/** A whole card as its not-yet-filled self: the same `PanelCard` chrome and the
 *  same kicker the real card will carry, so the only thing that changes when the
 *  stage settles is the content inside it.
 *
 *  The kicker is deliberately the REAL one, not "Loading…": naming what is
 *  coming is the entire point — a stage announces the shape of its evidence
 *  before it has any. */
export function SkeletonPanel({ kicker, awaiting, testId, rows = 2, variant = 'lines' }: {
  kicker: string
  awaiting: AwaitingState
  testId?: string
  rows?: number
  /** `lines` for prose/digest cards, `rows` for the ones that become a list. */
  variant?: 'lines' | 'rows'
}) {
  return (
    <PanelCard kicker={kicker} testId={testId ?? 'skeleton-panel'}>
      {variant === 'rows'
        ? <SkeletonRows awaiting={awaiting} rows={rows} />
        : <SkeletonLines awaiting={awaiting} rows={rows} />}
    </PanelCard>
  )
}
