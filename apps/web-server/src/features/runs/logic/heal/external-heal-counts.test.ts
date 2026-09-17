import { describe, expect, it } from 'vitest'
import type { RunDetail } from '../run-store'
import { normalizeRunCounts, statusLineForCounts } from './external-heal-counts'

// The status line is the one number an agent is allowed to read a verdict
// from, so it has to say when the skips are declared gates (settled, run is
// green) rather than a serial group that stopped early (not run, run is red).
describe('external heal counts and declared gates', () => {
  const knownTests = ['local-a', 'local-b', 'meta-a', 'meta-b'].map((name) => ({ name }))

  it('names the declared gates inside the skipped count', () => {
    const counts = normalizeRunCounts({
      complete: true,
      total: 4,
      passed: 2,
      passedNames: ['local-a', 'local-b'],
      skipped: 2,
      skippedNames: ['meta-a', 'meta-b'],
      gatedNames: ['meta-a', 'meta-b'],
      gatedReasons: ['meta only', 'meta only'],
      failed: [],
      knownTests,
    } as RunDetail['summary'])
    expect(counts.statusLine).toBe('2/4 passed, 0 failed, 2 skipped (2 declared gates), 0 not run')
    expect(counts.notRun).toBe(0)
  })

  it('leaves the line unchanged when the skips declared no reason', () => {
    const counts = normalizeRunCounts({
      complete: true,
      total: 4,
      passed: 2,
      passedNames: ['local-a', 'local-b'],
      skipped: 2,
      skippedNames: ['meta-a', 'meta-b'],
      failed: [],
      knownTests,
    } as RunDetail['summary'])
    expect(counts.statusLine).toBe('2/4 passed, 0 failed, 2 skipped, 0 not run')
  })

  it('only counts a gate that is also a recorded skip', () => {
    expect(statusLineForCounts({ totalKnown: 3, passed: 2, failed: 0, skipped: 1, notRun: 0, gated: 1 }))
      .toBe('2/3 passed, 0 failed, 1 skipped (1 declared gate), 0 not run')
    const counts = normalizeRunCounts({
      complete: true,
      total: 2,
      passed: 1,
      passedNames: ['local-a'],
      skipped: 1,
      skippedNames: ['meta-a'],
      gatedNames: ['meta-a', 'not-a-skip'],
      failed: [],
      knownTests: knownTests.slice(0, 3),
    } as RunDetail['summary'])
    expect(counts.statusLine).toBe('1/3 passed, 0 failed, 1 skipped (1 declared gate), 1 not run')
  })
})
