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
const { listLineFromTitlePath, knownTestFromTest, knownTestsFromExistingSummary } =
  await import('./summary-known-tests')

// Every expectation here was measured against Playwright 1.62 by feeding the
// output back through `playwright test --list --test-list <file>`. A line that
// does not match selects ZERO tests, and Playwright reports that as an ordinary
// empty run rather than an error — so these are the shapes standing between a
// targeted rerun and a verdict computed from nothing.
describe('listLineFromTitlePath', () => {
  it('drops the empty project slot when the config declares no named projects', () => {
    expect(listLineFromTitlePath(['', '', 'a.spec.ts', 'checkout flow', 'applies a discount (10% off)']))
      .toBe('a.spec.ts › checkout flow › applies a discount (10% off)')
  })

  it('wraps a named project in brackets, matching how Playwright renders it', () => {
    // The bare form `chromium › a.spec.ts › …` matches nothing at all.
    expect(listLineFromTitlePath(['', 'chromium', 'a.spec.ts', 'checkout flow', 'a title']))
      .toBe('[chromium] › a.spec.ts › checkout flow › a title')
  })

  it('keeps every nested suite title in order', () => {
    expect(listLineFromTitlePath(['', '', 'nested/c.spec.ts', 'outer', 'inner', 'deep test']))
      .toBe('nested/c.spec.ts › outer › inner › deep test')
  })

  it('returns undefined when there is no file plus title to identify a test', () => {
    expect(listLineFromTitlePath(['', '', 'a.spec.ts'])).toBeUndefined()
    expect(listLineFromTitlePath([])).toBeUndefined()
    expect(listLineFromTitlePath(['', 'chromium'])).toBeUndefined()
  })

  it('ignores non-string parts rather than rendering them', () => {
    expect(listLineFromTitlePath(['', '', 'a.spec.ts', undefined, 'a title']))
      .toBe('a.spec.ts › a title')
  })
})

// A `listLine` is only worth capturing if it SURVIVES to the rerun, and the two
// halves of that journey live in different functions: one reads Playwright's
// TestCase, the other re-reads the summary file a restart left behind. Testing
// them apart would let the write side keep emitting a field the read side had
// quietly started dropping, and the symptom is a rerun that selects zero tests
// and reports it as an ordinary empty run.
describe('listLine round trip: TestCase → summary file → replay', () => {
  const testCase = (titlePath: string[]) => ({
    title: titlePath[titlePath.length - 1],
    titlePath: () => titlePath,
    location: { file: '/repo/a.spec.ts', line: 12 },
  }) as never

  it('captures the rendered line off a TestCase and hands it back on replay', () => {
    const entry = knownTestFromTest(testCase(['', 'chromium', 'a.spec.ts', 'checkout flow', 'applies a discount']))
    expect(entry.listLine).toBe('[chromium] › a.spec.ts › checkout flow › applies a discount')
    // titlePath is the filtered form — it has lost the project slot, which is
    // exactly why listLine has to be stored rather than rebuilt from it later.
    expect(entry.titlePath).toEqual(['chromium', 'a.spec.ts', 'checkout flow', 'applies a discount'])

    const replayed = knownTestsFromExistingSummary({ knownTests: [JSON.parse(JSON.stringify(entry))] })
    expect(replayed).toHaveLength(1)
    expect(replayed[0].listLine).toBe(entry.listLine)
    expect(replayed[0].id).toBe(entry.id)
  })

  it('omits the field entirely when the TestCase cannot identify a file plus title', () => {
    // Not `listLine: undefined` — the entry is JSON-serialized into the summary,
    // and an absent key is what the replay side's string check expects.
    const entry = knownTestFromTest(testCase(['', '', 'only-a-title']))
    expect('listLine' in entry).toBe(false)
  })

  it('drops a replayed listLine that is present but empty', () => {
    const replayed = knownTestsFromExistingSummary({
      knownTests: [{ id: 'test-id-x', name: 'test-case-a', title: 'A', listLine: '' }],
    })
    expect('listLine' in replayed[0]).toBe(false)
  })
})

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
