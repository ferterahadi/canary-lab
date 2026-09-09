import type { DirtySpecSummary, Feature } from '@/shared/api/types'
import type { StrengthVerdict } from '@shared/verification-strength/types'
import { INTEGRITY_HINT_COPY, INTEGRITY_HINT_DISCLOSURE, INTEGRITY_HINT_FALSE_POSITIVE_RATE } from '@shared/verification-strength/disclosure'

// One reading of a feature's modified specs for the three review surfaces (the
// status-bar pill, the features-column badge, the review dialog), so a suite
// never shows one tone in the bar and another in the column. Three tones, not
// four: the differential's verdicts collapse to what a reader must DO about
// them. `weaker` earns an amber advisory cue, and it is a hint (D13) —
// `equivalent`, `unclassifiable` and "no verdict readable" all read as the same
// neutral "changed", because with the classifier's recall none of them is
// evidence that nothing weakened; a human still decides.
export type SpecEditTone = 'weaker' | 'changed' | 'stronger'

/** Worst-first over the differential's verdicts: one `weaker` wins; `stronger`
 *  needs every verdict to say so; anything else is `changed`. */
export function worstTone(verdicts: ReadonlyArray<StrengthVerdict | undefined>): SpecEditTone {
  if (verdicts.some((v) => v === 'weaker')) return 'weaker'
  if (verdicts.length > 0 && verdicts.every((v) => v === 'stronger')) return 'stronger'
  return 'changed'
}

/** The tone a spec's own verdict gives it; a spec with no readable verdict is
 *  `changed` — shown as such, never folded into equivalent. */
export function specTone(spec: DirtySpecSummary): SpecEditTone {
  return worstTone([spec.strength?.verdict])
}

/** The tone for a whole suite, or null when its specs are clean. */
export function featureTone(feature: Feature): SpecEditTone | null {
  if (feature.dirty?.status !== 'dirty') return null
  return worstTone(feature.dirty.specs.map((spec) => spec.strength?.verdict))
}

/** The glyph, hue and wording each tone carries — the same triple everywhere.
 *  Hues are the status vocabulary: amber = advisory attention,
 *  muted = changed with nothing to alarm about. */
export const SPEC_TONE: Record<SpecEditTone, { glyph: string; color: string; label: string; title: string }> = {
  weaker: {
    glyph: '!',
    color: 'var(--warning)',
    label: 'Weaker',
    title: `Hint: an edit reads weaker than what ran — false positive ${INTEGRITY_HINT_FALSE_POSITIVE_RATE}. ${INTEGRITY_HINT_DISCLOSURE}`,
  },
  changed: {
    glyph: '~',
    color: 'var(--text-muted)',
    label: 'Changed',
    title: 'Test files changed in the workspace — review before trusting the result',
  },
  stronger: {
    glyph: '↑',
    color: 'var(--text-secondary)',
    label: 'Stronger',
    title: 'Every edit reads stronger than what ran — review and commit',
  },
}

/** The full hint sentence, for surfaces with room for it (the review dialog). */
export const WEAKER_HINT_COPY = INTEGRITY_HINT_COPY
