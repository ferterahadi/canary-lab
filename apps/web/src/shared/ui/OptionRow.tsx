import type { CSSProperties } from 'react'

// The one pickable-row look, shared by every "choose one of these" list (the
// flight proposal's stage picker, the heal-behavior modes). Neutral surfaces
// only: a row sits on whatever grey it lands on and is never a tinted slab —
// selection is the app's selected-grey and nothing else. It carries no accent:
// blue is this app's "you can click this", and every row in a picker is
// clickable, so tinting the picked one blue said the opposite of what it meant.
//
// Deliberately a class + a style function rather than a component: the callers
// need different elements. A plain pick is a <button>; a row that owns its own
// controls (the heal mode carries a stepper) must be a role="radio" <div>,
// because a <button> cannot nest one. Sharing the look without forcing the
// element keeps both honest.
//
// The cursor lives here too, in BOTH directions. It used to be half-owned — the
// blocked `not-allowed` came from this function while every caller hand-wrote its
// own `cursor-pointer` utility — and the picker that forgot the utility (the
// start proposal's StageRow) showed a plain arrow on a pickable row while the
// other two showed a pointer. Callers say WHETHER their row answers a click via
// `interactive`; they must not add a cursor utility of their own.

export const OPTION_ROW_CLASS = 'flex items-start gap-3 px-3.5 py-2.5 text-left'

/** The one-line variant: a row whose whole choice fits on its label line, so
 *  the mark centres on it instead of hanging at the top of a paragraph. A
 *  separate constant rather than an override — appending `py-1.5` to the class
 *  above would leave two padding utilities fighting over stylesheet order. */
export const OPTION_ROW_COMPACT_CLASS = 'flex min-h-[40px] items-center gap-2.5 px-3 py-1.5 text-left'

export function optionRowStyle({ selected, disabled, interactive }: {
  selected: boolean
  /** Locked rows are NOT dimmed — a blanket opacity multiplies every child
   *  (label, reason, badge) down past readable, and the reason line is exactly
   *  what a locked row exists to say. Locked-ness rides on the cursor and the
   *  label dropping to secondary instead. */
  disabled?: boolean
  /** True when clicking this row actually DOES something — which is not the same
   *  as "is a control". A heal mode that's already picked guards its own handler,
   *  and a fresh flight's journey preview is display-only; neither should invite
   *  a click it will swallow. `disabled` still wins, so a blocked row reads
   *  `not-allowed` even in an otherwise live picker. */
  interactive?: boolean
}): CSSProperties {
  return {
    borderColor: 'var(--border-default)',
    background: selected ? 'var(--bg-selected)' : 'transparent',
    cursor: disabled ? 'not-allowed' : interactive ? 'pointer' : undefined,
  }
}
