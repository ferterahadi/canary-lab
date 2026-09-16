import type { ReactNode } from 'react'
import { MinusIcon, PencilIcon, PlusIcon } from './Icons'
import { Tooltip } from './Tooltip'
import type { TestChangeKind } from '../lib/test-versions'

/** What each drift mark means, in the words every surface uses. The counting
 *  rule travels with the glyph: "2 changed" is only unambiguous once you know a
 *  test counts once however many edits it holds. Callers compose their own
 *  sentence around `explanation`, because the same mark opens a comparison in
 *  the tests header and filters the stepper in the comparison footer. */
export const TEST_CHANGE_MARKS: Record<TestChangeKind, { label: string, tone: 'success' | 'warning' | 'danger', icon: ReactNode, explanation: string }> = {
  added: { label: 'new', tone: 'success', icon: <PlusIcon />, explanation: 'These test declarations were not in the recorded source. Each one counts once, even in a loop. Renamed or moved tests may appear as both new and removed.' },
  changed: { label: 'changed', tone: 'warning', icon: <PencilIcon />, explanation: 'Only changes inside an existing test(...) count. Each test counts once. Changes to imports or setup outside the test do not count.' },
  removed: { label: 'removed', tone: 'danger', icon: <MinusIcon />, explanation: 'A test(...) declaration in the recorded source that is absent from current source.' },
}

interface Props {
  kind: TestChangeKind
  count: number
  /** The hover sentence, composed by the caller so it can say what ITS click
   *  does — open the comparison, or show this kind in the stepper. */
  tooltip: string
  ariaLabel: string
  /** Set only where the trio acts as a filter and one kind is showing. Left
   *  undefined the button reports no pressed state, which is what a jump link
   *  wants — `aria-pressed="false"` on a link-like mark claims a toggle that
   *  isn't there. */
  pressed?: boolean
  disabled?: boolean
  onClick: () => void
}

/** A drift mark: tinted glyph, numeral, no border of its own. Two surfaces show
 *  the same three counts — how far current source has moved from the recorded
 *  run — so they render the same element rather than two near-copies that drift
 *  apart. Hover is the only chrome, so the mark still looks clickable. */
export function TestChangeMark({ kind, count, tooltip, ariaLabel, pressed, disabled, onClick }: Props) {
  const mark = TEST_CHANGE_MARKS[kind]
  return (
    <Tooltip label={tooltip}>
      <button type="button" className="cl-test-change" style={{ color: `var(--${mark.tone})` }}
        aria-label={ariaLabel} aria-pressed={pressed} disabled={disabled} onClick={onClick}>
        <span aria-hidden="true">{mark.icon}</span><span>{count}</span>
      </button>
    </Tooltip>
  )
}
