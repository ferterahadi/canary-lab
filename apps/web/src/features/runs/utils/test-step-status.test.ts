import { describe, it, expect } from 'vitest'

import {
  activeBodyLineForTest,
  slugify,
  summaryEntryName,
  statusForTest,
  statusFromPlaybackResult,
  colorClassForStatus,
  statusLabel,
  statusPillClassForStatus,
} from './test-step-status'

import type { RunSummary } from '@/shared/api/types'

const completeWithFailure = (msg: string): RunSummary => ({
  complete: true,
  total: 2,
  passed: 1,
  failed: [
    { name: 'test-case-creates-a-todo', error: { message: msg } },
  ],
})

// Status classes name the SEMANTIC token (`success`, `running`, `danger`,
// `warning`), never a raw Tailwind palette family. The token flips with the
// theme on its own, so these strings must not carry a `dark:` twin either —
// see the @theme bridge in styles.css and docs/DESIGN-SYSTEM.md.
const RAW_PALETTE_RE =
  /\b(slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}\b/

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

  it('returns testing when the reporter marks the test as currently running', () => {
    const inflight: RunSummary = {
      complete: false,
      total: 0,
      passed: 0,
      failed: [],
      running: { name: 'test-case-creates-a-todo', location: '/todo.spec.ts:12' },
    }
    expect(statusForTest('Creates a TODO', inflight)).toBe('testing')
  })

  it('returns testing for every test in the parallel runningTests list', () => {
    const inflight: RunSummary = {
      complete: false,
      total: 2,
      passed: 0,
      failed: [],
      running: { name: 'test-case-creates-a-todo', location: '/todo.spec.ts:12' },
      runningTests: [
        { name: 'test-case-creates-a-todo', location: '/todo.spec.ts:12' },
        { name: 'test-case-updates-a-todo', location: '/todo.spec.ts:22' },
      ],
    }

    expect(statusForTest('Creates a TODO', inflight)).toBe('testing')
    expect(statusForTest('Updates a TODO', inflight)).toBe('testing')
  })

  it('returns testing when a previously-failed test is currently re-running (targeted rerun)', () => {
    const targetedRerun: RunSummary = {
      complete: false,
      total: 2,
      passed: 1,
      failed: [{ name: 'test-case-creates-a-todo', error: { message: 'AssertionError: …' } }],
      running: { name: 'test-case-creates-a-todo', location: '/todo.spec.ts:12' },
    }
    expect(statusForTest('Creates a TODO', targetedRerun)).toBe('testing')
  })

  it('ignores stale running entries when the selected run is not actively testing', () => {
    const aborted: RunSummary = {
      complete: false,
      total: 2,
      passed: 1,
      failed: [],
      running: { name: 'test-case-creates-a-todo', location: '/todo.spec.ts:12' },
    }
    expect(statusForTest('Creates a TODO', aborted, false)).toBe('pending')
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

  it('uses test ids to distinguish duplicate test titles', () => {
    const summary: RunSummary = {
      complete: false,
      total: 2,
      passed: 1,
      failed: [],
      passedNames: ['test-case-validates-input'],
      passedIds: ['test-id-alpha'],
      knownTests: [
        { id: 'test-id-alpha', name: 'test-case-validates-input', title: 'validates input', location: '/a.spec.ts:10' },
        { id: 'test-id-beta', name: 'test-case-validates-input', title: 'validates input', location: '/a.spec.ts:30' },
      ],
    } as RunSummary

    expect(statusForTest({ name: 'validates input', id: 'test-id-alpha' }, summary)).toBe('passed')
    expect(statusForTest({ name: 'validates input', id: 'test-id-beta' }, summary)).toBe('pending')
  })

  it('uses skippedIds to mark a specific duplicate-title instance as skipped', () => {
    const summary: RunSummary = {
      complete: false,
      total: 2,
      passed: 0,
      failed: [],
      skipped: 1,
      skippedIds: ['test-id-alpha'],
      knownTests: [
        { id: 'test-id-alpha', name: 'test-case-validates-input', title: 'validates input', location: '/a.spec.ts:10' },
        { id: 'test-id-beta', name: 'test-case-validates-input', title: 'validates input', location: '/a.spec.ts:30' },
      ],
    } as RunSummary

    expect(statusForTest({ name: 'validates input', id: 'test-id-alpha' }, summary)).toBe('skipped')
    expect(statusForTest({ name: 'validates input', id: 'test-id-beta' }, summary)).toBe('pending')
  })

  it('returns testing when the identity id matches a parallel running entry', () => {
    const summary: RunSummary = {
      complete: false,
      total: 2,
      passed: 0,
      failed: [],
      runningTests: [
        { id: 'test-id-alpha', name: 'test-case-validates-input', location: '/a.spec.ts:10' },
        { id: 'test-id-beta', name: 'test-case-validates-input', location: '/a.spec.ts:30' },
      ],
    } as RunSummary

    expect(statusForTest({ name: 'validates input', id: 'test-id-beta' }, summary)).toBe('testing')
  })

  it('falls back to summary.running when only its id matches the identity id', () => {
    const summary: RunSummary = {
      complete: false,
      total: 2,
      passed: 0,
      failed: [],
      running: { id: 'test-id-alpha', name: 'test-case-validates-input', location: '/a.spec.ts:10' },
    } as RunSummary

    expect(statusForTest({ name: 'validates input', id: 'test-id-alpha' }, summary)).toBe('testing')
  })

  it('matches a failed entry by id even when titles collide', () => {
    const summary: RunSummary = {
      complete: true,
      total: 2,
      passed: 1,
      failed: [
        { id: 'test-id-alpha', name: 'test-case-validates-input', error: { message: 'AssertionError' } },
      ],
      passedIds: ['test-id-beta'],
      passedNames: ['test-case-validates-input'],
    } as RunSummary

    expect(statusForTest({ name: 'validates input', id: 'test-id-alpha' }, summary)).toBe('failed')
    expect(statusForTest({ name: 'validates input', id: 'test-id-beta' }, summary)).toBe('passed')
  })

  it('uses skippedNames to distinguish skipped vs failed', () => {
    const summary: RunSummary = {
      complete: false,
      total: 1,
      passed: 0,
      failed: [],
      skipped: 1,
      skippedNames: ['test-case-creates-a-todo'],
    }
    expect(statusForTest('Creates a TODO', summary)).toBe('skipped')
  })
})

describe('colorClassForStatus', () => {
  it.each([
    ['passed', 'success'],
    ['testing', 'running'],
    ['failed', 'danger'],
    ['timedout', 'warning'],
    ['skipped', 'warning'],
    ['pending', 'line-strong'],
  ] as const)('returns the %s status token for the card', (status, token) => {
    const className = colorClassForStatus(status)
    expect(className).toContain(token)
    expect(className).not.toMatch(RAW_PALETTE_RE)
  })
})

describe('statusPillClassForStatus', () => {
  it.each([
    ['testing', 'running'],
    ['failed', 'danger'],
    ['passed', 'success'],
    ['timedout', 'warning'],
    ['skipped', 'warning'],
  ] as const)('uses the requested chip token for %s', (status, token) => {
    const className = statusPillClassForStatus(status)
    expect(className).toContain(token)
    expect(className).toContain('border-')
    // One token class per property — no hand-written light/dark pair.
    expect(className).not.toContain('dark:')
    expect(className).not.toMatch(RAW_PALETTE_RE)
  })

  it('keeps pending neutral and outlined', () => {
    const className = statusPillClassForStatus('pending')
    expect(className).toContain('idle')
    expect(className).toContain('bg-transparent')
    expect(className).not.toMatch(RAW_PALETTE_RE)
  })
})

describe('statusLabel', () => {
  it('maps runtime names to user-facing chip labels', () => {
    expect(statusLabel('testing')).toBe('running')
    expect(statusLabel('passed')).toBe('passed')
    expect(statusLabel('failed')).toBe('failed')
    expect(statusLabel('timedout')).toBe('timeout')
    expect(statusLabel('pending')).toBe('pending')
    expect(statusLabel('skipped')).toBe('skipped')
  })
})

describe('statusFromPlaybackResult', () => {
  it.each([
    [{ status: 'passed', passed: true }, 'passed'],
    [{ status: 'failed', passed: false }, 'failed'],
    [{ status: 'skipped', passed: false }, 'skipped'],
    [{ status: 'timedOut', passed: false }, 'timedout'],
    [{ passed: false }, 'failed'],
    [{ passed: true }, 'passed'],
    [{}, 'testing'],
  ] as const)('normalizes playback result %#', (input, expected) => {
    expect(statusFromPlaybackResult(input)).toBe(expected)
  })
})
