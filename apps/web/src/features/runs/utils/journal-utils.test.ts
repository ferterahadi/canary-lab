import { describe, it, expect } from 'vitest'
import {
  parseBodyFields,
  classifyOutcome,
  outcomeBadgeClass,
  outcomeLabel,
  formatJournalFieldKey,
  presentJournalFields,
} from './journal-utils'
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
    ['all_passed', 'no_failures_recorded'],
    ['all_tests_passed', 'all_tests_passed'],
    ['applicable_passed', 'applicable_passed'],
    ['failures_cleared', 'failures_cleared'],
    ['advanced', 'advanced'],
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
    const outcomes = ['pending', 'all_tests_passed', 'advanced', 'partial', 'no_change', 'regression', 'unknown'] as const
    const seen = new Set<string>()
    for (const o of outcomes) {
      const cls = outcomeBadgeClass(o)
      expect(typeof cls).toBe('string')
      seen.add(cls)
    }
    expect(seen.size).toBe(outcomes.length)
  })
})

describe('outcomeLabel', () => {
  it('uses a reader-friendly label for applicable passes and expands ordinary outcome keys', () => {
    expect(outcomeLabel('applicable_passed')).toBe('applicable tests passed')
    expect(outcomeLabel('all_tests_passed')).toBe('all tests passed')
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
