import { describe, expect, it } from 'vitest'
import { BODY_MAX_CHARS, BODY_MIN_CHARS, EMPTY_COPY, TITLE_MAX_CHARS, healNoTranscriptCopy } from './empty-state-copy'
import { EMPTY_REASON, type EmptyReason } from './EmptyState'

// The band is the whole design: `EmptyState` reserves a three-line body box, and
// these bounds are what guarantee the copy always fills it and never overflows.
// A body written outside them makes one pane a different height from every other
// pane, which is the exact defect this file exists to prevent — so this suite
// fails on the copy, not on the component.
const entries = Object.entries(EMPTY_COPY)

describe('empty-state copy is one size', () => {
  it.each(entries)('%s body sits in the three-line band', (_key, copy) => {
    expect(copy.body.length).toBeGreaterThanOrEqual(BODY_MIN_CHARS)
    expect(copy.body.length).toBeLessThanOrEqual(BODY_MAX_CHARS)
  })

  it.each(entries)('%s title stays on one line', (_key, copy) => {
    expect(copy.title.length).toBeLessThanOrEqual(TITLE_MAX_CHARS)
  })

  // The count is interpolated, so the band has to hold across every cycle count
  // a run can plausibly reach — not just the one example a fixture would pick.
  it.each([1, 2, 9, 10, 42, 99])('the %i-cycle transcript body stays in band', (cycles) => {
    const copy = healNoTranscriptCopy(cycles)
    expect(copy.body.length).toBeGreaterThanOrEqual(BODY_MIN_CHARS)
    expect(copy.body.length).toBeLessThanOrEqual(BODY_MAX_CHARS)
    expect(copy.title.length).toBeLessThanOrEqual(TITLE_MAX_CHARS)
  })

  it('spends every reason, so none is a dead branch of the design', () => {
    const used = new Set<EmptyReason>([...entries.map(([, c]) => c.reason), healNoTranscriptCopy(1).reason])
    expect([...used].sort()).toEqual(Object.keys(EMPTY_REASON).sort())
  })
})
