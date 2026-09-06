import { StatusPill } from '@/shared/ui/StatusPill'
import { SPEC_TONE } from '../utils/spec-integrity'

// Status-bar pill surfaced while one or more suites have modified test files
// (Surface 1's notification), or an active run holds spec edits it has not
// executed. Two readings, one pill:
//   - neutral "Tests changed" — an edit the differential read as equivalent or
//     stronger, could not read, or a pending edit awaiting a human's adopt. No
//     danger: with the classifier's recall none of these is an alarm, and none
//     is a clean bill either. The count is suites; the detail names how many
//     wait on a live run.
//   - danger "Tests weakened · hint" — at least one edit reads weaker than what
//     ran. Danger tone belongs to this reading alone, and the pill says "hint"
//     because that is what it is (D13): 2.4% of such readings were wrong on the
//     holdout, and it never changes a verdict. The count is the weakened suites,
//     so the number a reader sees is the number worth reading.
// A one-shot pulse when the count changes so a fresh edit announces itself.
// Self-guards: renders nothing when nothing changed.
export function DirtyTestsPill({
  suites,
  weakerSuites,
  pendingSuites,
  onOpen,
}: {
  /** Suites with a modified spec or a pending edit. */
  suites: number
  /** Suites where at least one edit reads weaker than what ran. */
  weakerSuites: number
  /** Suites whose live run holds edits it has not executed (awaiting adopt). */
  pendingSuites: number
  onOpen: () => void
}) {
  if (suites <= 0) return null
  if (weakerSuites > 0) {
    return (
      <StatusPill
        dotState="failed"
        name="Tests weakened"
        detail="hint"
        count={weakerSuites}
        countTone="danger"
        emphasis
        emphasisTone="danger"
        freshPulseKey={suites}
        onClick={onOpen}
        title={SPEC_TONE.weaker.title}
        ariaLabel={`${weakerSuites} suite${weakerSuites > 1 ? 's' : ''} with an edit that reads weaker than what ran — a hint; review`}
      />
    )
  }
  return (
    <StatusPill
      dotState="idle"
      name="Tests changed"
      detail={pendingSuites > 0 ? `${pendingSuites} awaiting adopt` : undefined}
      count={suites}
      freshPulseKey={suites}
      onClick={onOpen}
      title={pendingSuites > 0
        ? `${SPEC_TONE.changed.title}. ${pendingSuites} suite${pendingSuites > 1 ? 's have' : ' has'} edits a live run has not executed — adopt or restore them.`
        : SPEC_TONE.changed.title}
      ariaLabel={`${suites} suite${suites > 1 ? 's' : ''} with changed test files — review`}
    />
  )
}
