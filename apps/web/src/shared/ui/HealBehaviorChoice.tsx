import type { ReactNode } from 'react'
import { plural } from '@shared/lib/plural'
import { healDisplayValue, healEnabled } from '@/shared/lib/heal-threshold'
import { NumberInput } from './FormFields'
import { OPTION_ROW_COMPACT_CLASS, optionRowStyle } from './OptionRow'

// ─── Heal behavior: one choice, rendered the same on every surface ──────────
// `healOnFailureThreshold` is stored as a count, but what the user picks is the
// SHAPE of the run: stop at N failures and hand those to the repair agent, or
// let every test finish first. A switch stated only half of that — the "off"
// consequence surfaced only AFTER you flipped it — so both shapes are always on
// screen, and both surfaces that edit this field (the flight Suite setup digest
// and Advanced setup's General tab) render this component rather than each
// inventing its own control.
//
// The first version said each shape three times over: a label, a two-line
// consequence, and a bar schematic of how much suite runs. Three encodings of
// one fact is what made it heavy. Now the labels carry the shapes and ONE line
// under the pair carries the trade — it swaps with the selection, so the rows
// keep their height and nothing moves.
//
// Selection is said twice and no more: the filled mark, and the picked row on
// the app's selected-grey. No accent bar, no second tone on the mark's ring —
// both were extra ways of saying what the mark already says.

/** The mechanism behind the field, for the surface's own hover affordance. One
 *  home so the flight digest and the General tab can't drift apart on it. */
export const HEAL_BEHAVIOR_INFO =
  'Each test run starts with this failure limit. Changing it mid-run takes effect on the next run, not the one already going.'

export function HealBehaviorChoice({ threshold, editable, onChange, testIdPrefix = 'setup-heal', className = '', lockedTitle, preserveControlsWhenLocked = false }: {
  /** `feature.config.cjs`'s `healOnFailureThreshold`; absent = on at the default. */
  threshold: number | undefined
  /** False mid-run: the rows still name both shapes, they just aren't controls. */
  editable: boolean
  onChange: (threshold: number) => void
  testIdPrefix?: string
  /** Lets a card bleed the rows past its own padding (`-mx-3`), so the selected
   *  band and the hover tint span the card edge-to-edge while the rows' own
   *  `px-3` keeps the labels under the kicker. */
  className?: string
  /** Why the rows aren't controls, when `editable` is false. */
  lockedTitle?: string
  /** Keep the editable layout in place while locked. Flight Page uses this for
   *  external ownership so internal and external modes show the same parts. */
  preserveControlsWhenLocked?: boolean
}) {
  const stopping = healEnabled(threshold)
  const count = healDisplayValue(threshold)
  const controlsVisible = editable || preserveControlsWhenLocked
  return (
    // The bleed rides on the wrapper, not the radiogroup, so the trade line
    // shares the rows' left edge on BOTH surfaces — hung off the group instead,
    // the line sat 12px right of the labels in a bled card and 23px left of
    // them in an unbled one.
    <div className={`flex flex-col gap-1.5 ${className}`}>
      <div
        role={controlsVisible ? 'radiogroup' : undefined}
        aria-label="Auto-repair"
        title={editable ? undefined : lockedTitle}
        className="flex flex-col"
      >
        <HealModeRow
          testId={`${testIdPrefix}-mode-stop`}
          selected={stopping}
          editable={editable}
          preserveControl={controlsVisible}
          onPick={() => onChange(count)}
          label={controlsVisible ? (
            <span className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
              Stop &amp; repair after
              {/* A disabled <button>/<input> swallows the click instead of
                  bubbling it, so on the unpicked row the stepper — the widest,
                  most clickable-looking thing in it — would be a dead zone that
                  silently refuses to select the mode. Taking it out of
                  hit-testing hands those clicks to the row. */}
              <span style={stopping ? undefined : { pointerEvents: 'none' }}>
                <NumberInput
                  min={1}
                  value={count}
                  disabled={!editable || !stopping}
                  testId={`${testIdPrefix}-threshold`}
                  onChange={onChange}
                />
              </span>
              {count === 1 ? 'failure' : 'failures'}
            </span>
          ) : (
            `Stop & repair after ${plural(count, 'failure')}`
          )}
        />
        <HealModeRow
          testId={`${testIdPrefix}-mode-full`}
          selected={!stopping}
          editable={editable}
          preserveControl={controlsVisible}
          onPick={() => onChange(0)}
          divider
          label="Run the whole suite, then repair"
        />
      </div>
    </div>
  )
}

/** One heal mode. A row is a `role="radio"` div rather than a button because the
 *  first one carries the threshold stepper, and a <button> cannot nest one;
 *  clicking anywhere in a deselected row (the disabled stepper included) picks
 *  it. */
function HealModeRow({ testId, selected, editable, preserveControl, onPick, label, divider }: {
  testId: string
  selected: boolean
  editable: boolean
  preserveControl: boolean
  onPick: () => void
  label: ReactNode
  divider?: boolean
}) {
  const pick = (): void => { if (editable && !selected) onPick() }
  return (
    <div
      data-testid={testId}
      role={preserveControl ? 'radio' : undefined}
      aria-checked={preserveControl ? selected : undefined}
      aria-disabled={preserveControl && !editable ? true : undefined}
      tabIndex={editable ? 0 : undefined}
      onClick={pick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick() }
      }}
      className={`${OPTION_ROW_COMPACT_CLASS} ${editable && !selected ? 'cl-hover-row' : ''} ${divider ? 'border-t' : ''}`}
      style={optionRowStyle({ selected, interactive: editable && !selected })}
    >
      {/* One ring tone in both states — only the fill moves. It's `--text-muted`
          (the resting-icon token) rather than `--border-default`, because the
          picked row's band IS `--bg-selected` and those two greys are the same
          value in both themes: a border-toned ring would vanish exactly where
          the mark matters most. Tokens via utilities, so neither state needs a
          `dark:` twin. */}
      <span
        aria-hidden="true"
        className="flex h-[13px] w-[13px] shrink-0 items-center justify-center rounded-full border border-muted"
      >
        {selected && <span className="h-[6px] w-[6px] rounded-full bg-primary" />}
      </span>
      <span className={`min-w-0 flex-1 text-[12.5px] font-medium ${selected ? 'text-primary' : 'text-secondary'}`}>
        {label}
      </span>
    </div>
  )
}
