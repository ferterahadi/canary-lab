import type { CSSProperties } from 'react'
import { PanelCard } from './PanelCard'

// R83 — the one placeholder vocabulary. A stage pane keeps the layout its
// SETTLED state has, in every state: each card that a finished stage shows is
// rendered here as its own shape with the figures replaced by bars, so a value
// lands in the slot its placeholder held instead of pushing the pane around
// when the stage finishes.
//
// R86 — the placeholder's FILL is what says why the slot is empty, because the
// shape alone said the same thing in four different situations:
//   live   filled bar, sweeping   a value is being produced right now
//   idle   hollow dashed track    the slot is held open; nothing comes until you act
//   failed struck danger track    the value will never land here
//   unavailable muted outline     the step settled without recording this value
// The fill (not the animation) carries this, deliberately: the headless preview
// forces reduced-motion, so a viewer with no animation must still be able to
// tell a working stage from a parked one from a broken one.

/** Why a card is showing placeholders: `live` (a stage is working on it),
 *  `idle` (pending or paused — nothing is coming until the user acts),
 *  `failed` (the stage stopped short, so these slots stay empty until a retry),
 *  or `unavailable` (the step settled without recording that evidence). */
export type AwaitingState = 'live' | 'idle' | 'failed' | 'unavailable'

/** The pane's empty-slot state, from the stage's own status. One home keeps the
 *  full evidence layout mounted while distinguishing a settled omission from a
 *  value that is pending, live, or blocked on retry. */
export function awaitingFor(status: string, live: boolean): AwaitingState {
  if (status === 'done' || status === 'skipped') return 'unavailable'
  if (live) return 'live'
  return status === 'failed' ? 'failed' : 'idle'
}

/** The fill per state. `live` is the only filled bar — the sweep class adds the
 *  motion on top of it. `idle` and `failed` are the same held-open outline in
 *  different hues, which is the point: the slot is identical, only the reason it
 *  is empty differs. `failed` takes its strike-through from `.cl-skeleton-void`,
 *  so it sets no background here.
 *
 *  The outline is SOLID, not dashed: a bar is 7–9px tall, and a dashed border at
 *  that size reads as a dotted texture — the pill stops looking like a slot. */
const BAR_FILL: Record<AwaitingState, CSSProperties> = {
  live: { background: 'var(--border-strong)' },
  idle: { border: '1px solid var(--border-strong)', boxSizing: 'border-box' },
  failed: {
    border: '1px solid color-mix(in srgb, var(--danger) 45%, transparent)',
    boxSizing: 'border-box',
  },
  unavailable: { border: '1px solid var(--border-default)', boxSizing: 'border-box' },
}

const BAR_CLASS: Record<AwaitingState, string> = {
  live: ' cl-skeleton',
  idle: '',
  failed: ' cl-skeleton-void',
  unavailable: '',
}

const BEAD_BORDER: Record<AwaitingState, string> = {
  live: 'var(--border-strong)',
  idle: 'var(--border-strong)',
  failed: 'var(--danger)',
  unavailable: 'var(--border-default)',
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
      data-awaiting={awaiting}
      className={`block rounded-full${BAR_CLASS[awaiting]}${className ? ` ${className}` : ''}`}
      style={{ width, height, ...BAR_FILL[awaiting] }}
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

/** The leading indicator a row carries (StepList's bead, RunRow's status dot).
 *  Exported because a card that composes its OWN row geometry — the Test Run
 *  hero, whose three blocks each sit at a different left edge — must reuse this
 *  bead rather than hand-roll a second circle that drifts from it.
 *
 *  The bead tracks the same four states as the bars: a failed row's indicator
 *  is the one dot the user will look for when scanning which rows a retry still
 *  owes. */
export function SkeletonBead({ awaiting, size = 9, className = '' }: {
  awaiting: AwaitingState
  /** Match the dot the real row carries — RunRow's is 0.55rem, a failure row's 6px. */
  size?: number
  className?: string
}) {
  return (
    <span
      aria-hidden
      data-testid="skeleton-bead"
      className={`shrink-0 rounded-full border${className ? ` ${className}` : ''}`}
      style={{
        height: size,
        width: size,
        borderColor: BEAD_BORDER[awaiting],
      }}
    />
  )
}

/** A list row's shape: the leading indicator every row-list on a stage carries
 *  plus a title bar and a quieter sub-line, so a skeleton list reads as the list
 *  it will become. */
export function SkeletonRow({ awaiting, sub = true }: { awaiting: AwaitingState; sub?: boolean }) {
  return (
    <li className="flex items-start gap-2.5 py-1.5" data-testid="skeleton-row">
      <SkeletonBead awaiting={awaiting} className="mt-[3px]" />
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
