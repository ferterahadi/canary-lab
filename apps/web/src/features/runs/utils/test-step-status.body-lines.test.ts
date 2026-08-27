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
import type { RunSummary } from '@/shared/api/types'

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

  it('maps from bodyLine when a multiline declaration starts above the displayed body', () => {
    expect(activeBodyLineForTest({
      testName: 'Creates a TODO',
      testLine: 49,
      bodyLine: 52,
      bodySource: '{\n  await page.goto(\"/\")\n}',
      sourceFile: '/features/cns/e2e/todo.spec.ts',
      summary: {
        ...summary,
        running: {
          ...summary.running!,
          location: '/features/cns/e2e/todo.spec.ts:49',
          step: {
            ...summary.running!.step!,
            location: '/features/cns/e2e/todo.spec.ts:53',
          },
        },
      },
    })).toBe(2)
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

  it('does not use a same-title sibling when stable test ids differ', () => {
    const duplicateTitleSummary: RunSummary = {
      ...summary,
      running: {
        id: 'test-id-alpha',
        name: 'test-case-creates-a-todo',
        location: '/todo.spec.ts:10',
        step: {
          title: 'expect(locator).toBeVisible',
          category: 'expect',
          location: '/todo.spec.ts:12',
        },
      },
    }
    expect(activeBodyLineForTest({
      testName: 'Creates a TODO',
      testId: 'test-id-beta',
      testLine: 10,
      bodySource: '{\n  await page.goto(\"/\")\n  await expect(locator).toBeVisible()\n}',
      summary: duplicateTitleSummary,
    })).toBeNull()
    expect(activeBodyLineForTest({
      testName: 'Creates a TODO',
      testId: 'test-id-alpha',
      testLine: 10,
      bodySource: '{\n  await page.goto(\"/\")\n  await expect(locator).toBeVisible()\n}',
      summary: duplicateTitleSummary,
    })).toBe(3)
  })

  it('does not highlight by title when an exact modern test identity was not resolved', () => {
    expect(activeBodyLineForTest({
      testName: 'Creates a TODO',
      allowNameFallback: false,
      testLine: 10,
      bodySource: '{\n  await page.goto(\"/\")\n  await expect(locator).toBeVisible()\n}',
      summary,
    })).toBeNull()
  })

  it('returns null when no test is running or the location has no line number', () => {
    expect(activeBodyLineForTest({
      testName: 'Creates a TODO',
      testLine: 10,
      bodySource: '{\n  await page.goto(\"/\")\n}',
      summary: undefined,
    })).toBeNull()

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

  it('prefers the spec-body call site over a helper line that also maps in range', () => {
    // Both locations fall inside the displayed body range, but only the spec
    // file is the code shown in the card. Without file awareness the deepest
    // (helper) location would win and highlight the wrong line.
    expect(activeBodyLineForTest({
      testName: 'Creates a TODO',
      testLine: 10,
      bodySource: '{\n  await page.goto(\"/\")\n  await redeemCode(page)\n}',
      sourceFile: '/todo.spec.ts',
      summary: {
        ...summary,
        running: {
          ...summary.running!,
          step: {
            ...summary.running!.step!,
            location: '/helpers/voucher.ts:11',
            locations: ['/helpers/voucher.ts:11', '/todo.spec.ts:12'],
          },
        },
      },
    })).toBe(3)
  })

  it('returns null while running inside a helper with no spec-body location', () => {
    // Mirrors the real Playwright shape: a pw:api step deep in a helper reports
    // only the helper file, even when its line happens to map into the body
    // range. We must not highlight a line that is not the shown source.
    expect(activeBodyLineForTest({
      testName: 'Creates a TODO',
      testLine: 10,
      bodySource: '{\n  await page.goto(\"/\")\n  await redeemCode(page)\n}',
      sourceFile: '/todo.spec.ts',
      summary: {
        ...summary,
        running: {
          ...summary.running!,
          step: {
            ...summary.running!.step!,
            location: '/helpers/voucher.ts:12',
            locations: ['/helpers/voucher.ts:12'],
          },
        },
      },
    })).toBeNull()
  })

  it('returns null when the matching spec-file location is outside the body range', () => {
    // The location is in the shown source file but its line maps outside the
    // body range, so there is no in-range line to highlight.
    expect(activeBodyLineForTest({
      testName: 'Creates a TODO',
      testLine: 10,
      bodySource: '{\n  await page.goto(\"/\")\n}',
      sourceFile: '/todo.spec.ts',
      summary: {
        ...summary,
        running: {
          ...summary.running!,
          step: { ...summary.running!.step!, location: '/todo.spec.ts:9999', locations: ['/todo.spec.ts:9999'] },
        },
      },
    })).toBeNull()
  })

  it('ignores locations with no line suffix or an empty file path', () => {
    // 'noline' has no :line → no file parsed; ':12' has an empty file path.
    // Neither can match the shown source, so nothing is highlighted.
    expect(activeBodyLineForTest({
      testName: 'Creates a TODO',
      testLine: 10,
      bodySource: '{\n  await page.goto(\"/\")\n}',
      sourceFile: '/todo.spec.ts',
      summary: {
        ...summary,
        running: {
          ...summary.running!,
          step: { ...summary.running!.step!, location: 'noline', locations: ['noline', ':12'] },
        },
      },
    })).toBeNull()
  })

  it('matches the same feature file across different checkout roots', () => {
    expect(activeBodyLineForTest({
      testName: 'Creates a TODO',
      testLine: 10,
      bodySource: '{\n  await page.goto(\"/\")\n  await expect(locator).toBeVisible()\n}',
      sourceFile: '/abs/features/x/e2e/todo.spec.ts',
      summary: {
        ...summary,
        running: {
          ...summary.running!,
          step: {
            ...summary.running!.step!,
            location: '/worktree/features/x/e2e/todo.spec.ts:12',
            locations: ['/worktree/features/x/e2e/todo.spec.ts:12'],
          },
        },
      },
    })).toBe(3)
  })

  it('does not match unrelated files that only share a basename', () => {
    expect(activeBodyLineForTest({
      testName: 'Creates a TODO',
      testLine: 10,
      bodySource: '{\n  await page.goto(\"/\")\n  await expect(locator).toBeVisible()\n}',
      sourceFile: '/abs/features/x/e2e/todo.spec.ts',
      summary: {
        ...summary,
        running: {
          ...summary.running!,
          step: {
            ...summary.running!.step!,
            location: '/abs/features/y/e2e/todo.spec.ts:12',
            locations: ['/abs/features/y/e2e/todo.spec.ts:12'],
          },
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
