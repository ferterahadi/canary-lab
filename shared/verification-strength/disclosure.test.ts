import { describe, expect, it } from 'vitest'
import { INTEGRITY_HINT_COPY, INTEGRITY_HINT_DISCLOSURE, INTEGRITY_HINT_FALSE_POSITIVE_RATE } from './disclosure'

// The rule these words carry (D13 / rubric § Labeller): a detection number is
// never quoted without saying how it was checked, and a hint is never framed as
// a verdict. Pinned so a copy edit cannot drop either half.
describe('integrity hint disclosure', () => {
  it('names the check: one AI labelled, a second checked without seeing the labels, no human', () => {
    expect(INTEGRITY_HINT_DISCLOSURE).toMatch(/one AI labelled/i)
    expect(INTEGRITY_HINT_DISCLOSURE).toMatch(/second AI checked 40 samples without seeing those labels/i)
    expect(INTEGRITY_HINT_DISCLOSURE).toMatch(/no human/i)
  })

  it('frames the hint as advisory, never a verdict', () => {
    expect(INTEGRITY_HINT_DISCLOSURE).toMatch(/does not change the run result/)
    expect(INTEGRITY_HINT_COPY).toMatch(/^A hint, not a verdict/)
  })

  it('quotes the false-positive rate only alongside the disclosure', () => {
    expect(INTEGRITY_HINT_COPY).toContain(INTEGRITY_HINT_FALSE_POSITIVE_RATE)
    expect(INTEGRITY_HINT_COPY).toContain(INTEGRITY_HINT_DISCLOSURE)
    expect(INTEGRITY_HINT_COPY).toMatch(/falsely flagged a weakening/)
  })
})
