import { describe, it, expect } from 'vitest'
import {
  slugify,
  summaryEntryName,
  statusForTest,
  colorClassForStatus,
} from './test-step-status'
import type { RunSummary } from '../api/types'

const completeWithFailure = (msg: string): RunSummary => ({
  complete: true,
  total: 2,
  passed: 1,
  failed: [
    { name: 'test-case-creates-a-todo', error: { message: msg } },
  ],
})

describe('slugify', () => {
  it('lowercases and dashifies non-alphanumerics', () => {
    expect(slugify('Creates a TODO')).toBe('creates-a-todo')
  })

  it('strips leading/trailing dashes', () => {
    expect(slugify(' --hi! ')).toBe('hi')
  })

  it('collapses multiple separators', () => {
    expect(slugify('a   b__c!!d')).toBe('a-b-c-d')
  })
})

describe('summaryEntryName', () => {
  it('prefixes test-case- to slugged title', () => {
    expect(summaryEntryName('Creates a TODO')).toBe('test-case-creates-a-todo')
  })
})

describe('statusForTest', () => {
  it('returns pending when summary is undefined', () => {
    expect(statusForTest('foo', undefined)).toBe('pending')
  })

  it('returns failed when test appears in failed[] without timeout', () => {
    expect(statusForTest('Creates a TODO', completeWithFailure('AssertionError: …'))).toBe('failed')
  })

  it('returns timedout when failure error message indicates a Playwright timeout', () => {
    expect(
      statusForTest('Creates a TODO', completeWithFailure('Test timeout of 30000ms exceeded.')),
    ).toBe('timedout')
  })

  it('returns passed when run is complete and test is not in failed[]', () => {
    expect(
      statusForTest('Other test', completeWithFailure('AssertionError')),
    ).toBe('passed')
  })

  it('treats a failure without an error object as failed (not timedout)', () => {
    const summary: RunSummary = {
      complete: true,
      total: 1,
      passed: 0,
      failed: [{ name: 'test-case-creates-a-todo' }],
    }
    expect(statusForTest('Creates a TODO', summary)).toBe('failed')
  })

  it('returns pending when run is in-flight and test has not failed', () => {
    const inflight: RunSummary = { complete: false, total: 0, passed: 0, failed: [] }
    expect(statusForTest('Creates a TODO', inflight)).toBe('pending')
  })

  it('uses passedNames to distinguish passed vs pending', () => {
    const summary: RunSummary = {
      complete: false,
      total: 2,
      passed: 1,
      failed: [],
      passedNames: ['test-case-creates-a-todo'],
    }
    expect(statusForTest('Creates a TODO', summary)).toBe('passed')
    expect(statusForTest('Other test', summary)).toBe('pending')
  })
})

describe('colorClassForStatus', () => {
  it('returns a green class for passed', () => {
    expect(colorClassForStatus('passed')).toContain('emerald')
  })
  it('returns a red class for failed', () => {
    expect(colorClassForStatus('failed')).toContain('rose')
  })
  it('returns an amber class for timedout', () => {
    expect(colorClassForStatus('timedout')).toContain('amber')
  })
  it('returns an amber class for skipped', () => {
    expect(colorClassForStatus('skipped')).toContain('amber')
  })
  it('returns a neutral class for pending', () => {
    expect(colorClassForStatus('pending')).toContain('zinc')
  })
})
