import { describe, it, expect } from 'vitest'
import {
  newestFirst,
  filterEntries,
  parseBodyFields,
  classifyOutcome,
  outcomeBadgeClass,
  formatJournalFieldKey,
  presentJournalFields,
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

  it('treats missing iteration like null when sorting', () => {
    const missingIteration = entry({}) as JournalEntry
    delete (missingIteration as { iteration?: number | null }).iteration

    const out = newestFirst([missingIteration, entry({ iteration: 2 })])
    expect(out.map((e) => e.iteration ?? null)).toEqual([2, null])
  })

  it('sinks null iteration when the null entry is already last', () => {
    // V8's sort calls compare(arr[i+1], arr[i]), so we need the nullish
    // entry as the *later* element to exercise the `a.iteration ?? ...`
    // nullish arm (as opposed to `b.iteration ?? ...` which fires when
    // the null entry is first).
    const out = newestFirst([entry({ iteration: 5 }), entry({ iteration: null })])
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

describe('formatJournalFieldKey', () => {
  it('returns the friendly label for the four allowed fields', () => {
    expect(formatJournalFieldKey('hypothesis')).toBe('hypothesis')
    expect(formatJournalFieldKey('fix.description')).toBe('fix description')
    expect(formatJournalFieldKey('signal')).toBe('signal')
    expect(formatJournalFieldKey('outcome')).toBe('outcome')
  })

  it('hides plumbing fields the human does not need', () => {
    expect(formatJournalFieldKey('run')).toBeNull()
    expect(formatJournalFieldKey('feature')).toBeNull()
    expect(formatJournalFieldKey('failingTests')).toBeNull()
    expect(formatJournalFieldKey('fix.file')).toBeNull()
  })

  it('hides anything not on the allowlist (no fall-through)', () => {
    expect(formatJournalFieldKey('metadata')).toBeNull()
    expect(formatJournalFieldKey('channel')).toBeNull()
    expect(formatJournalFieldKey('something-new')).toBeNull()
  })
})

describe('presentJournalFields', () => {
  it('keeps only the four allowed fields and renames them, preserving order', () => {
    const parsed = [
      { key: 'run', value: '2026-05-11T0230-v0c3' },
      { key: 'feature', value: 'demo' },
      { key: 'failingTests', value: 'test-case-x' },
      { key: 'hypothesis', value: 'guard returns early' },
      { key: 'fix.file', value: '/repo/a.ts, /repo/b.ts' },
      { key: 'fix.description', value: 'added bounds check' },
      { key: 'signal', value: '.restart' },
      { key: 'outcome', value: 'pending' },
    ]
    expect(presentJournalFields(parsed)).toEqual([
      { key: 'hypothesis', value: 'guard returns early' },
      { key: 'fix description', value: 'added bounds check' },
      { key: 'signal', value: '.restart' },
      { key: 'outcome', value: 'pending' },
    ])
  })

  it('drops keys that look like fields but came from diff-block noise', () => {
    const parsed = [
      { key: 'hypothesis', value: 'fixed it' },
      { key: 'metadata', value: '{ ... }' },
      { key: 'channel', value: "'call'" },
      { key: 'logger', value: 'thislogger' },
    ]
    expect(presentJournalFields(parsed)).toEqual([
      { key: 'hypothesis', value: 'fixed it' },
    ])
  })

  it('returns an empty list when no allowed fields are present', () => {
    expect(presentJournalFields([
      { key: 'run', value: 'r1' },
      { key: 'feature', value: 'demo' },
      { key: 'mystery', value: 'v' },
    ])).toEqual([])
  })
})
