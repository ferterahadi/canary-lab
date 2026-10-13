import { describe, it, expect } from 'vitest'
import type { RunDetail } from './run-detail'
import { normalizeRunCounts } from './run-counts'

describe('normalizeRunCounts', () => {
  it('returns zero counts and an empty status line when the summary is null', () => {
    const counts = normalizeRunCounts(null)
    expect(counts).toMatchObject({
      totalKnown: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
      notRun: 0,
      statusLine: '0/0 passed, 0 failed, 0 not run',
    })
  })

  it('skips malformed knownTests entries (non-objects, missing names, non-string names)', () => {
    const summary = {
      complete: false,
      total: 1,
      passed: 1,
      passedNames: ['real test'],
      knownTests: [
        null,
        'not-an-object',
        42,
        { id: 'orphan' }, // missing name → dropped
        { id: 'wrong-name-type', name: 123 }, // non-string name → coerced to '' then dropped
        { name: '' }, // empty name → dropped
        { name: 'real test' },
      ],
      failed: [],
      skipped: 0,
    } as unknown as RunDetail['summary']

    const counts = normalizeRunCounts(summary)
    expect(counts.totalKnown).toBe(1)
    expect(counts.passed).toBe(1)
    expect(counts.notRun).toBe(0)
    expect(counts.notRunNames).toEqual([])
  })

  it('includes a skipped segment in the status line when any tests are skipped', () => {
    const summary = {
      complete: false,
      total: 3,
      passed: 1,
      passedNames: ['a'],
      knownTests: [{ name: 'a' }, { name: 'b' }, { name: 'c' }],
      failed: [],
      skipped: 1,
      skippedNames: ['b'],
    } as unknown as RunDetail['summary']

    const counts = normalizeRunCounts(summary)
    expect(counts.skipped).toBe(1)
    expect(counts.statusLine).toBe('1/3 passed, 0 failed, 1 skipped, 1 not run')
  })

  it('treats non-finite fallback totals as zero', () => {
    const counts = normalizeRunCounts({
      complete: false,
      total: Number.NaN,
      passed: 0,
      failed: [],
      skipped: 0,
    })

    expect(counts.totalKnown).toBe(0)
    expect(counts.statusLine).toBe('0/0 passed, 0 failed, 0 not run')
  })

  it('uses numeric fallback totals when known tests are absent', () => {
    const counts = normalizeRunCounts({
      complete: false,
      total: 4,
      passed: 1,
      failed: [{ name: 'failed test' }],
      skipped: 1,
    })

    expect(counts.totalKnown).toBe(4)
    expect(counts.notRun).toBe(1)
    expect(counts.statusLine).toBe('1/4 passed, 1 failed, 1 skipped, 1 not run')
  })
})
