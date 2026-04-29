import { describe, it, expect } from 'vitest'
import {
  newestFirst,
  filterEntries,
  parseBodyFields,
  classifyOutcome,
  outcomeBadgeClass,
} from './journal-utils'
import type { JournalEntry } from '../api/types'

const entry = (overrides: Partial<JournalEntry>): JournalEntry => ({
  iteration: 1,
  timestamp: 't',
  feature: null,
  run: null,
  outcome: null,
  hypothesis: null,
  body: '',
  ...overrides,
})

describe('newestFirst', () => {
  it('sorts by iteration descending', () => {
    const out = newestFirst([entry({ iteration: 1 }), entry({ iteration: 3 }), entry({ iteration: 2 })])
    expect(out.map((e) => e.iteration)).toEqual([3, 2, 1])
  })

  it('sinks entries with null iteration to the bottom', () => {
    const out = newestFirst([entry({ iteration: null }), entry({ iteration: 5 })])
    expect(out.map((e) => e.iteration)).toEqual([5, null])
  })

  it('treats equal iterations as stable (returns 0)', () => {
    const out = newestFirst([
      entry({ iteration: 2, hypothesis: 'a' }),
      entry({ iteration: 2, hypothesis: 'b' }),
    ])
    expect(out).toHaveLength(2)
  })
})

describe('filterEntries', () => {
  const data = [
    entry({ iteration: 1, feature: 'foo', run: 'r1' }),
    entry({ iteration: 2, feature: 'bar', run: 'r2' }),
    entry({ iteration: 3, feature: 'foo', run: 'r2' }),
  ]

  it('returns all when filter is empty', () => {
    expect(filterEntries(data, {})).toHaveLength(3)
  })

  it('filters by feature', () => {
    expect(filterEntries(data, { feature: 'foo' }).map((e) => e.iteration)).toEqual([1, 3])
  })

  it('filters by run', () => {
    expect(filterEntries(data, { run: 'r2' }).map((e) => e.iteration)).toEqual([2, 3])
  })

  it('combines feature and run filters', () => {
    expect(filterEntries(data, { feature: 'foo', run: 'r2' }).map((e) => e.iteration)).toEqual([3])
  })
})

describe('parseBodyFields', () => {
  it('extracts key/value field lines', () => {
    const body = `## Iteration 1\n\n- feature: foo\n- run: r1\n- fix.file: src/a.ts\n\nfree text`
    expect(parseBodyFields(body)).toEqual([
      { key: 'feature', value: 'foo' },
      { key: 'run', value: 'r1' },
      { key: 'fix.file', value: 'src/a.ts' },
    ])
  })

  it('returns [] when no field lines present', () => {
    expect(parseBodyFields('just prose')).toEqual([])
  })
})

describe('classifyOutcome', () => {
  it.each([
    ['pending', 'pending'],
    ['all_passed', 'all_passed'],
    ['partial', 'partial'],
    ['no_change', 'no_change'],
    ['regression', 'regression'],
  ] as const)('classifies %s', (input, expected) => {
    expect(classifyOutcome(input)).toBe(expected)
  })

  it('returns unknown for null/missing', () => {
    expect(classifyOutcome(null)).toBe('unknown')
    expect(classifyOutcome(undefined)).toBe('unknown')
  })

  it('returns unknown for arbitrary strings', () => {
    expect(classifyOutcome('weird')).toBe('unknown')
  })
})

describe('outcomeBadgeClass', () => {
  it('returns distinct classes per outcome', () => {
    const outcomes = ['pending', 'all_passed', 'partial', 'no_change', 'regression', 'unknown'] as const
    const seen = new Set<string>()
    for (const o of outcomes) {
      const cls = outcomeBadgeClass(o)
      expect(typeof cls).toBe('string')
      seen.add(cls)
    }
    expect(seen.size).toBe(outcomes.length)
  })
})
