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
import { sourceLineForBodyLine } from './editor-location'
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
  it('returns a green class for passed', () => {
    expect(colorClassForStatus('passed')).toContain('emerald')
  })
  it('returns a blue class for testing', () => {
    expect(colorClassForStatus('testing')).toContain('sky')
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

describe('statusPillClassForStatus', () => {
  it.each([
    ['testing', 'sky'],
    ['failed', 'rose'],
    ['passed', 'emerald'],
    ['timedout', 'amber'],
    ['skipped', 'amber'],
  ] as const)('uses the requested chip color for %s', (status, hue) => {
    const className = statusPillClassForStatus(status)
    expect(className).toContain(hue)
    expect(className).toContain('border-')
    expect(className).toContain('dark:')
  })

  it('keeps pending neutral and outlined', () => {
    const className = statusPillClassForStatus('pending')
    expect(className).toContain('zinc')
    expect(className).toContain('bg-transparent')
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

describe('activeBodyLineForTest', () => {
  const summary: RunSummary = {
    complete: false,
    total: 0,
    passed: 0,
    failed: [],
    running: {
      name: 'test-case-creates-a-todo',
      location: '/todo.spec.ts:10',
      step: {
        title: 'expect(locator).toBeVisible',
        category: 'expect',
        location: '/todo.spec.ts:12',
      },
    },
  }

  it('maps an absolute source line inside the test body to a displayed body line', () => {
    expect(activeBodyLineForTest({
      testName: 'Creates a TODO',
      testLine: 10,
      bodySource: '{\n  await page.goto(\"/\")\n  await expect(locator).toBeVisible()\n}',
      summary,
    })).toBe(3)
  })

  it('returns null when the step location is outside the displayed body', () => {
    expect(activeBodyLineForTest({
      testName: 'Creates a TODO',
      testLine: 10,
      bodySource: '{\n  await page.goto(\"/\")\n}',
      summary: {
        ...summary,
        running: {
          ...summary.running!,
          step: {
            ...summary.running!.step!,
            location: '/todo.spec.ts:14',
          },
        },
      },
    })).toBeNull()
  })

  it('uses the first step location that falls inside the displayed body', () => {
    expect(activeBodyLineForTest({
      testName: 'Creates a TODO',
      testLine: 10,
      bodySource: '{\n  await page.goto(\"/\")\n  await redeemCode(page)\n}',
      summary: {
        ...summary,
        running: {
          ...summary.running!,
          step: {
            ...summary.running!.step!,
            location: '/helpers/voucher.ts:4',
            locations: ['/helpers/voucher.ts:4', '/todo.spec.ts:12'],
          },
        },
      },
    })).toBe(3)
  })

  it('uses persisted failed locations after the test stops running', () => {
    expect(activeBodyLineForTest({
      testName: 'Creates a TODO',
      testLine: 10,
      bodySource: '{\n  await page.goto(\"/\")\n  await expect(locator).toBeVisible()\n}',
      summary: {
        complete: true,
        total: 1,
        passed: 0,
        failed: [
          {
            name: 'test-case-creates-a-todo',
            location: '/todo.spec.ts:10',
            locations: ['/todo.spec.ts:12'],
          },
        ],
      },
    })).toBe(3)
  })

  it('falls back to the failed entry location when locations is absent entirely', () => {
    expect(activeBodyLineForTest({
      testName: 'Creates a TODO',
      testLine: 10,
      bodySource: '{\n  await page.goto(\"/\")\n  await expect(locator).toBeVisible()\n}',
      summary: {
        complete: true,
        total: 1,
        passed: 0,
        failed: [
          {
            name: 'test-case-creates-a-todo',
            location: '/todo.spec.ts:12',
          },
        ],
      },
    })).toBe(3)
  })

  it('falls back to the failed entry location when locations is empty', () => {
    expect(activeBodyLineForTest({
      testName: 'Creates a TODO',
      testLine: 10,
      bodySource: '{\n  await page.goto(\"/\")\n  await expect(locator).toBeVisible()\n}',
      summary: {
        complete: true,
        total: 1,
        passed: 0,
        failed: [
          {
            name: 'test-case-creates-a-todo',
            location: '/todo.spec.ts:12',
            locations: [],
          },
        ],
      },
    })).toBe(3)
  })

  it('returns null when the failed entry has neither locations nor location', () => {
    expect(activeBodyLineForTest({
      testName: 'Creates a TODO',
      testLine: 10,
      bodySource: '{\n  await page.goto(\"/\")\n}',
      summary: {
        complete: true,
        total: 1,
        passed: 0,
        failed: [
          {
            name: 'test-case-creates-a-todo',
          },
        ],
      },
    })).toBeNull()
  })

  it('keeps the highlight on the parent test body when a child helper location appears first', () => {
    expect(activeBodyLineForTest({
      testName: 'Creates a TODO',
      testLine: 10,
      bodySource: '{\n  await page.goto(\"/\")\n  await redeemCode(page)\n}',
      summary: {
        complete: true,
        total: 1,
        passed: 0,
        failed: [
          {
            name: 'test-case-creates-a-todo',
            location: '/todo.spec.ts:10',
            locations: ['/helpers/voucher.ts:4', '/todo.spec.ts:12'],
          },
        ],
      },
    })).toBe(3)
  })

  it('returns null when the running step has no location', () => {
    expect(activeBodyLineForTest({
      testName: 'Creates a TODO',
      testLine: 10,
      bodySource: '{\n  await page.goto(\"/\")\n}',
      summary: {
        ...summary,
        running: {
          name: 'test-case-creates-a-todo',
          location: '/todo.spec.ts:10',
          step: { title: 'setup', category: 'fixture' },
        },
      },
    })).toBeNull()
  })

  it('returns null when another test is running', () => {
    expect(activeBodyLineForTest({
      testName: 'Other test',
      testLine: 10,
      bodySource: '{\n  await page.goto(\"/\")\n}',
      summary,
    })).toBeNull()
  })

  it('returns null when no test is running or the location has no line number', () => {
    expect(activeBodyLineForTest({
      testName: 'Creates a TODO',
      testLine: 10,
      bodySource: '{\n  await page.goto(\"/\")\n}',
      summary: { complete: false, total: 0, passed: 0, failed: [] },
    })).toBeNull()

    expect(activeBodyLineForTest({
      testName: 'Creates a TODO',
      testLine: 10,
      bodySource: '{\n  await page.goto(\"/\")\n}',
      summary: {
        complete: false,
        total: 0,
        passed: 0,
        failed: [],
        running: {
          name: 'test-case-creates-a-todo',
          location: '/todo.spec.ts',
          step: { title: 'setup', category: 'fixture', location: '/todo.spec.ts' },
        },
      },
    })).toBeNull()
  })

  it('returns null when the location matches but the line number overflows to Infinity', () => {
    // Exercise the `Number.isFinite(line) ? line : null` falsy arm in
    // lineFromLocation — only reachable when the regex captures a digit
    // string so long that Number() rounds it to Infinity.
    const hugeLine = '1' + '0'.repeat(400)
    expect(activeBodyLineForTest({
      testName: 'Creates a TODO',
      testLine: 10,
      bodySource: '{\n  await page.goto(\"/\")\n}',
      summary: {
        complete: false,
        total: 0,
        passed: 0,
        failed: [],
        running: {
          name: 'test-case-creates-a-todo',
          location: '/todo.spec.ts',
          step: { title: 'step', category: 'test.step', location: `/todo.spec.ts:${hugeLine}` },
        },
      },
    })).toBeNull()
  })
})

describe('sourceLineForBodyLine', () => {
  it('maps a displayed snippet body line back to the source file line', () => {
    expect(sourceLineForBodyLine(61, 4)).toBe(64)
  })
})
