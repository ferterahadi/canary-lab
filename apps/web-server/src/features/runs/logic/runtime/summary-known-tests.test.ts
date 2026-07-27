import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-sr-')))

const LOGS_DIR = path.join(tmpRoot, 'logs')

const traceMocks = vi.hoisted(() => ({
  extractTraceSummary: vi.fn(),
}))

vi.mock('./paths', () => ({
  ROOT: tmpRoot,
  LOGS_DIR,
  MANIFEST_PATH: path.join(LOGS_DIR, 'manifest.json'),
  SUMMARY_PATH: path.join(LOGS_DIR, 'e2e-summary.json'),
  DIAGNOSIS_JOURNAL_PATH: path.join(LOGS_DIR, 'diagnosis-journal.md'),
  HEAL_INDEX_PATH: path.join(LOGS_DIR, 'heal-index.md'),
  FAILED_DIR: path.join(LOGS_DIR, 'failed'),
  getSummaryPath: () =>
    process.env.CANARY_LAB_SUMMARY_PATH ?? path.join(LOGS_DIR, 'e2e-summary.json'),
}))

vi.mock('./trace-enrichment', () => ({
  extractTraceSummary: traceMocks.extractTraceSummary,
}))

const { slugify, testIdFor, default: SummaryReporter } = await import('./summary-reporter')

afterEach(() => {
  fs.rmSync(LOGS_DIR, { recursive: true, force: true })
  traceMocks.extractTraceSummary.mockReset()
  delete process.env.CANARY_LAB_SUMMARY_PATH
  delete process.env.CANARY_LAB_MANIFEST_PATH
  delete process.env.CANARY_LAB_BENCHMARK_MODE
  delete process.env.CANARY_LAB_TARGETED_RERUN
})

function mkTest(title: string, file = '/spec.ts', line = 1): any {
  return { title, location: { file, line } }
}

function mkResult(overrides: Partial<any> = {}): any {
  return { status: 'passed', duration: 42, retry: 0, ...overrides }
}

function readSummary(): any {
  return JSON.parse(fs.readFileSync(path.join(LOGS_DIR, 'e2e-summary.json'), 'utf-8'))
}

describe('SummaryReporter', () => {
  it('writes collision-safe ids for duplicate-title results', () => {
    const reporter = new SummaryReporter()
    reporter.onBegin({} as any, {
      allTests: () => [
        { ...mkTest('validates duplicate', '/a.spec.ts', 10), titlePath: () => ['group a', 'validates duplicate'] },
        { ...mkTest('validates duplicate', '/a.spec.ts', 20), titlePath: () => ['group b', 'validates duplicate'] },
      ],
    } as any)
    reporter.onTestEnd(
      { ...mkTest('validates duplicate', '/a.spec.ts', 10), titlePath: () => ['group a', 'validates duplicate'] },
      mkResult(),
    )
    reporter.onTestEnd(
      { ...mkTest('validates duplicate', '/a.spec.ts', 20), titlePath: () => ['group b', 'validates duplicate'] },
      mkResult({ status: 'failed', error: { message: 'boom' } }),
    )

    const summary = readSummary()
    expect(summary.knownTests).toEqual([
      expect.objectContaining({
        id: expect.any(String),
        name: 'test-case-validates-duplicate',
        title: 'validates duplicate',
        location: '/a.spec.ts:10',
      }),
      expect.objectContaining({
        id: expect.any(String),
        name: 'test-case-validates-duplicate',
        title: 'validates duplicate',
        location: '/a.spec.ts:20',
      }),
    ])
    expect(summary.knownTests[0].id).not.toBe(summary.knownTests[1].id)
    expect(summary.passedNames).toEqual(['test-case-validates-duplicate'])
    expect(summary.passedIds).toEqual([summary.knownTests[0].id])
    expect(summary.failed).toEqual([
      expect.objectContaining({
        id: summary.knownTests[1].id,
        name: 'test-case-validates-duplicate',
      }),
    ])
  })

  it('merges knownTests and prior statuses across targeted reruns', () => {
    fs.mkdirSync(LOGS_DIR, { recursive: true })
    fs.writeFileSync(path.join(LOGS_DIR, 'e2e-summary.json'), JSON.stringify({
      complete: true,
      total: 3,
      passed: 1,
      passedNames: ['test-case-old-pass'],
      knownTests: [
        { name: 'test-case-old-pass', title: 'old pass', location: '/a.spec.ts:1' },
        { name: 'test-case-old-fail', title: 'old fail', location: '/helpers/spec-factory.ts:54' },
        { name: 'test-case-still-pending', title: 'still pending', location: '/helpers/spec-factory.ts:58' },
      ],
      failed: [
        { name: 'test-case-old-fail', location: '/helpers/spec-factory.ts:54' },
      ],
    }))
    process.env.CANARY_LAB_TARGETED_RERUN = '1'

    const reporter = new SummaryReporter()
    reporter.onBegin({} as any, {
      allTests: () => [mkTest('old fail', '/helpers/spec-factory.ts', 54)],
    } as any)
    reporter.onTestEnd(mkTest('old fail', '/helpers/spec-factory.ts', 54), mkResult())
    reporter.onEnd({} as any)

    expect(readSummary()).toMatchObject({
      complete: true,
      total: 3,
      passed: 2,
      passedNames: ['test-case-old-pass', 'test-case-old-fail'],
      knownTests: [
        { name: 'test-case-old-pass', title: 'old pass', location: '/a.spec.ts:1' },
        { name: 'test-case-old-fail', title: 'old fail', location: '/helpers/spec-factory.ts:54' },
        { name: 'test-case-still-pending', title: 'still pending', location: '/helpers/spec-factory.ts:58' },
      ],
      failed: [],
    })
  })

  it('merges targeted-rerun knownTests by title path when source lines drift', () => {
    fs.mkdirSync(LOGS_DIR, { recursive: true })
    const oldId = testIdFor({
      title: 'line drift',
      titlePath: ['spec.ts', 'group', 'line drift'],
      location: '/spec.ts:10',
    })
    fs.writeFileSync(path.join(LOGS_DIR, 'e2e-summary.json'), JSON.stringify({
      complete: true,
      total: 1,
      passed: 1,
      passedNames: ['test-case-line-drift'],
      passedIds: [oldId],
      knownTests: [
        {
          id: oldId,
          name: 'test-case-line-drift',
          title: 'line drift',
          titlePath: ['spec.ts', 'group', 'line drift'],
          location: '/spec.ts:10',
        },
      ],
      failed: [],
    }))
    process.env.CANARY_LAB_TARGETED_RERUN = '1'

    const reporter = new SummaryReporter()
    reporter.onBegin({} as any, {
      allTests: () => [
        { ...mkTest('line drift', '/spec.ts', 12), titlePath: () => ['spec.ts', 'group', 'line drift'] },
      ],
    } as any)
    reporter.onEnd({} as any)

    const out = readSummary()
    expect(out.total).toBe(1)
    expect(out.knownTests).toEqual([
      {
        id: testIdFor({
          title: 'line drift',
          titlePath: ['spec.ts', 'group', 'line drift'],
          location: '/spec.ts:12',
        }),
        name: 'test-case-line-drift',
        title: 'line drift',
        titlePath: ['spec.ts', 'group', 'line drift'],
        location: '/spec.ts:12',
      },
    ])
    expect(out.passedIds).toEqual([out.knownTests[0].id])
  })

  it('tolerates malformed existing summaries during a targeted rerun seed', () => {
    // Exercises the defensive validation inside seedFromExistingSummary —
    // non-array fields, non-string / empty / duplicate names, failed
    // entries without a name. The reporter must absorb all of these
    // without throwing and produce a clean baseline summary.
    process.env.CANARY_LAB_TARGETED_RERUN = '1'
    fs.mkdirSync(LOGS_DIR, { recursive: true })
    fs.writeFileSync(
      path.join(LOGS_DIR, 'e2e-summary.json'),
      JSON.stringify({
        passedNames: 'not-an-array',
        skippedNames: [null, 123, '', 'test-case-skipped-once', 'test-case-skipped-once'],
        failed: [
          null,
          'string-entry',
          { error: { message: 'no-name' } },
          { name: 'test-case-keep-me', error: { message: 'real' }, durationMs: 5, retry: 1, logFiles: ['ok.log', 42] },
          { name: 'test-case-keep-me', error: { message: 'dup' } },
        ],
      }),
    )

    const reporter = new SummaryReporter()
    reporter.onTestBegin(mkTest('Brand new test', '/specs/new.spec.ts', 3))

    const out = readSummary()
    expect(out.failed.map((f: { name: string }) => f.name)).toEqual(['test-case-keep-me'])
    expect(out.skippedNames).toEqual(['test-case-skipped-once'])
    expect(out.passedNames).toEqual([])
  })

  it('seeds valid passed, skipped, and failed targeted-rerun results with optional fields', () => {
    process.env.CANARY_LAB_TARGETED_RERUN = '1'
    fs.mkdirSync(LOGS_DIR, { recursive: true })
    fs.writeFileSync(
      path.join(LOGS_DIR, 'e2e-summary.json'),
      JSON.stringify({
        passedNames: ['test-case-passed-once', 'test-case-passed-once', ''],
        skippedNames: ['test-case-skipped-once', 123],
        failed: [
          {
            name: 'test-case-failed-once',
            error: { message: 'old fail', snippet: 'expect(false).toBe(true)' },
            durationMs: 9,
            location: '/specs/fail.spec.ts:4',
            locations: ['/specs/fail.spec.ts:4', 12],
            retry: 2,
            logFiles: ['logs/runs/run-1/failed/test-case-failed-once/svc.log', false],
          },
        ],
      }),
    )

    const reporter = new SummaryReporter()
    reporter.onEnd({} as any)

    expect(readSummary()).toEqual({
      complete: true,
      total: 3,
      passed: 1,
      passedNames: ['test-case-passed-once'],
      skipped: 1,
      skippedNames: ['test-case-skipped-once'],
      failed: [
        {
          name: 'test-case-failed-once',
          error: { message: 'old fail', snippet: 'expect(false).toBe(true)' },
          durationMs: 9,
          location: '/specs/fail.spec.ts:4',
          locations: ['/specs/fail.spec.ts:4'],
          retry: 2,
          logFiles: ['logs/runs/run-1/failed/test-case-failed-once/svc.log'],
        },
      ],
    })
  })
})
