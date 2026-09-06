import { describe, expect, it } from 'vitest'
import { INTEGRITY_HINT_COPY, INTEGRITY_HINT_DISCLOSURE, INTEGRITY_HINT_FALSE_POSITIVE_RATE } from './disclosure'

// The rule these words carry (D13 / rubric § Labeller): a detection number is
// never quoted without saying how it was checked, and a hint is never framed as
// a verdict. Pinned so a copy edit cannot drop either half.
describe('integrity hint disclosure', () => {
  it('names the check: one AI labelled, a second checked blind, no human', () => {
    expect(INTEGRITY_HINT_DISCLOSURE).toMatch(/one AI labelled/)
    expect(INTEGRITY_HINT_DISCLOSURE).toMatch(/second AI checked blind/)
    expect(INTEGRITY_HINT_DISCLOSURE).toMatch(/no human/)
  })

  it('frames the hint as advisory, never a verdict', () => {
    expect(INTEGRITY_HINT_DISCLOSURE).toMatch(/never changes a verdict/)
    expect(INTEGRITY_HINT_COPY).toMatch(/^A hint, not a verdict/)
  })

  it('quotes the false-positive rate only alongside the disclosure', () => {
    expect(INTEGRITY_HINT_COPY).toContain(INTEGRITY_HINT_FALSE_POSITIVE_RATE)
    expect(INTEGRITY_HINT_COPY).toContain(INTEGRITY_HINT_DISCLOSURE)
    expect(INTEGRITY_HINT_COPY).toMatch(/holdout/)
  })
})
