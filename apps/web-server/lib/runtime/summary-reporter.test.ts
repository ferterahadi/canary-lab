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

function mkStep(title: string, category: string, file?: string, line?: number): any {
  return {
    title,
    category,
    ...(file && line ? { location: { file, line } } : {}),
  }
}

function mkChildStep(title: string, category: string, parent: any, file?: string, line?: number): any {
  return {
    ...mkStep(title, category, file, line),
    parent,
  }
}

function readSummary(): any {
  return JSON.parse(fs.readFileSync(path.join(LOGS_DIR, 'e2e-summary.json'), 'utf-8'))
}

function readEvents(runDir = LOGS_DIR): any[] {
  return fs.readFileSync(path.join(runDir, 'playwright-events.jsonl'), 'utf-8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

describe('slugify', () => {
  it('normalizes test titles into summary slugs', () => {
    expect(slugify('A sad Checkout!')).toBe('a-sad-checkout')
    expect(slugify('  version 1.2.3  ')).toBe('version-1-2-3')
  })
})

describe('SummaryReporter', () => {
  it('writes partial and final e2e-summary.json with failure details', () => {
    const reporter = new SummaryReporter()
    reporter.onTestEnd(mkTest('A happy test', '/a.spec.ts', 10), mkResult())

    expect(readSummary()).toEqual({
      complete: false,
      total: 1,
      passed: 1,
      passedNames: ['test-case-a-happy-test'],
      passedIds: [expect.any(String)],
      failed: [],
    })

    reporter.onTestEnd(
      mkTest('The sad test', '/b.spec.ts', 22),
      mkResult({
        status: 'failed',
        duration: 99,
        retry: 1,
        error: { message: 'boom', snippet: 'expect(x).toBe(y)' },
      }),
    )
    reporter.onEnd({} as any)

    expect(readSummary()).toEqual({
      complete: true,
      total: 2,
      passed: 1,
      passedNames: ['test-case-a-happy-test'],
      passedIds: [expect.any(String)],
      failed: [
        {
          id: expect.any(String),
          name: 'test-case-the-sad-test',
          error: { message: 'boom', snippet: 'expect(x).toBe(y)' },
          durationMs: 99,
          location: '/b.spec.ts:22',
          retry: 1,
        },
      ],
    })
  })

  it('persists the Playwright suite inventory before any test has finished', () => {
    const reporter = new SummaryReporter()

    reporter.onBegin({} as any, {
      allTests: () => [
        { ...mkTest('factory one', '/helpers/spec-factory.ts', 54), titlePath: () => ['matrix', 'factory one'] },
        { ...mkTest('factory two', '/helpers/spec-factory.ts', 58), titlePath: () => ['matrix', 'factory two'] },
      ],
    } as any)

    expect(readSummary()).toMatchObject({
      complete: false,
      total: 2,
      passed: 0,
      passedNames: [],
      knownTests: [
        {
          id: expect.any(String),
          name: 'test-case-factory-one',
          title: 'factory one',
          titlePath: ['matrix', 'factory one'],
          location: '/helpers/spec-factory.ts:54',
        },
        {
          id: expect.any(String),
          name: 'test-case-factory-two',
          title: 'factory two',
          titlePath: ['matrix', 'factory two'],
          location: '/helpers/spec-factory.ts:58',
        },
      ],
    })
  })

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

  it('strips ANSI noise and truncates large error fields', () => {
    const reporter = new SummaryReporter()
    reporter.onTestEnd(
      mkTest('ANSI fail'),
      mkResult({
        status: 'failed',
        error: {
          message: `\x1b[31m${'x'.repeat(1200)}\x1b[39m`,
          snippet: `\x1b[32m${'y'.repeat(700)}\x1b[39m`,
        },
      }),
    )

    const out = readSummary()
    expect(out.failed[0].error.message).toHaveLength(1000)
    expect(out.failed[0].error.snippet).toHaveLength(500)
    expect(JSON.stringify(out)).not.toMatch(/\x1b\[/)
  })

  it('falls back to an empty error message when Playwright omits message text', () => {
    const reporter = new SummaryReporter()
    reporter.onTestEnd(
      mkTest('message-less fail'),
      mkResult({
        status: 'failed',
        error: {},
      }),
    )

    expect(readSummary().failed[0].error).toEqual({ message: '' })
  })

  it('normalizes failed result locations from error objects, stacks, and failed steps', () => {
    process.env.CANARY_LAB_BENCHMARK_MODE = 'baseline'
    const reporter = new SummaryReporter()
    const test = mkTest('location rich fail', '/specs/main.spec.ts', 8)
    const parent = mkStep('outer', 'test.step', '/specs/main.spec.ts', 9)
    const child = mkChildStep('inner', 'expect', parent, '/specs/main.spec.ts', 10)
    reporter.onTestBegin(test)
    reporter.onStepBegin(test, mkResult(), parent)
    reporter.onStepBegin(test, mkResult(), child)
    reporter.onStepEnd(test, mkResult(), { ...child, error: { message: 'step failed' } })
    reporter.onTestEnd(
      test,
      mkResult({
        status: 'failed',
        error: {
          message: 'boom',
          location: { file: '/specs/main.spec.ts', line: 11 },
        },
        errors: [
          {
            location: { file: '/specs/main.spec.ts', line: 12 },
            stack: 'Error: boom\n    at fn (/specs/main.spec.ts:13:7)\n    at fn (/specs/main.spec.ts:13:7)',
          },
          { stack: '' },
        ],
      }),
    )

    expect(readSummary().failed[0].locations).toEqual([
      '/specs/main.spec.ts:11',
      '/specs/main.spec.ts:12',
      '/specs/main.spec.ts:13',
      '/specs/main.spec.ts:10',
      '/specs/main.spec.ts:9',
    ])
  })

  it('writes the currently running test on begin and clears it on end', () => {
    const reporter = new SummaryReporter()
    reporter.onTestBegin(mkTest('Currently busy', '/specs/busy.spec.ts', 7))

    expect(readSummary()).toMatchObject({
      complete: false,
      total: 0,
      passed: 0,
      passedNames: [],
      running: {
        name: 'test-case-currently-busy',
        location: '/specs/busy.spec.ts:7',
      },
      failed: [],
    })

    reporter.onTestEnd(mkTest('Currently busy', '/specs/busy.spec.ts', 7), mkResult())
    expect(readSummary().running).toBeUndefined()
    expect(readSummary().runningTests).toBeUndefined()
  })

  it('tracks multiple currently running tests for parallel Playwright workers', () => {
    const reporter = new SummaryReporter()
    const first = mkTest('First worker', '/specs/first.spec.ts', 7)
    const second = mkTest('Second worker', '/specs/second.spec.ts', 11)

    reporter.onTestBegin(first)
    reporter.onTestBegin(second)

    expect(readSummary()).toMatchObject({
      running: {
        name: 'test-case-first-worker',
        location: '/specs/first.spec.ts:7',
      },
      runningTests: [
        {
          name: 'test-case-first-worker',
          location: '/specs/first.spec.ts:7',
        },
        {
          name: 'test-case-second-worker',
          location: '/specs/second.spec.ts:11',
        },
      ],
    })

    reporter.onTestEnd(first, mkResult())
    expect(readSummary()).toMatchObject({
      running: {
        name: 'test-case-second-worker',
        location: '/specs/second.spec.ts:11',
      },
      runningTests: [
        {
          name: 'test-case-second-worker',
          location: '/specs/second.spec.ts:11',
        },
      ],
    })
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
    expect(out.failed.map((f) => f.name)).toEqual(['test-case-keep-me'])
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

  it('replays a rich existing summary with explicit ids in knownTests, passedIds, skippedIds, and failed entries', () => {
    // Exercises every "id is present" branch in replayFromExistingSummary +
    // knownTestsFromExistingSummary + idForExistingResult: passedIds /
    // skippedIds arrays, an explicit failed entry id, location-based
    // resolution against a known test, and single-match by-name resolution.
    process.env.CANARY_LAB_TARGETED_RERUN = '1'
    fs.mkdirSync(LOGS_DIR, { recursive: true })

    // Compute the test-A id with the production helper so onTestEnd's
    // computed id matches the replayed result — this triggers the
    // first-try findIndex hit inside removeResult.
    const idA = testIdFor({ title: 'A', location: '/spec.ts:1' })
    const idB = 'test-id-known-b'
    const idC = 'test-id-known-c'
    const idD = 'test-id-known-d'
    const idE = 'test-id-known-e'

    fs.writeFileSync(
      path.join(LOGS_DIR, 'e2e-summary.json'),
      JSON.stringify({
        knownTests: [
          { id: idA, name: 'test-case-a', title: 'A', location: '/spec.ts:1' },
          { id: idB, name: 'test-case-b', title: 'B', location: '/spec.ts:2' },
          { id: idC, name: 'test-case-c', title: 'C', location: '/spec.ts:3' },
          { id: idD, name: 'test-case-d', title: 'D', location: '/spec.ts:4' },
          { id: idE, name: 'test-case-e', title: 'E', location: '/spec.ts:5' },
        ],
        passedNames: ['test-case-a', 'test-case-b'],
        // passedIds is an array but only covers idx=0 — idx=1 falls through
        // to idForExistingResult({ name: 'test-case-b' }), which finds a
        // single non-legacy match in knownTests and returns idB.
        passedIds: [idA],
        skippedNames: ['test-case-c'],
        skippedIds: [idC],
        failed: [
          // Explicit string id on the failed entry.
          { name: 'test-case-d', id: idD, error: { message: 'fail-d' } },
          // No id but a location matches a knownTests entry exactly.
          { name: 'test-case-e', location: '/spec.ts:5', error: { message: 'fail-e' } },
        ],
      }),
    )

    const reporter = new SummaryReporter()

    // Drive onTestEnd for test A so the replayed-by-id entry is removed via
    // the first findIndex (covers the "id resolved on first try" branch).
    reporter.onTestEnd(
      { title: 'A', location: { file: '/spec.ts', line: 1 } } as any,
      mkResult({ status: 'passed' }),
    )
    reporter.onEnd({} as any)

    const out = readSummary()
    expect(out.passedNames).toEqual(expect.arrayContaining(['test-case-a', 'test-case-b']))
    expect(out.passedIds).toEqual(expect.arrayContaining([idA, idB]))
    expect(out.skippedNames).toEqual(['test-case-c'])
    expect(out.skippedIds).toEqual([idC])
    expect(out.failed).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: idD, name: 'test-case-d' }),
      expect.objectContaining({ id: idE, name: 'test-case-e', location: '/spec.ts:5' }),
    ]))
  })

  it('skips the existing-summary seed when the file parses to a non-object value', () => {
    // Exercises the `!parsed || typeof parsed !== 'object'` truthy arm —
    // a bare JSON literal (number) parses successfully but isn't a record.
    process.env.CANARY_LAB_TARGETED_RERUN = '1'
    fs.mkdirSync(LOGS_DIR, { recursive: true })
    fs.writeFileSync(path.join(LOGS_DIR, 'e2e-summary.json'), '123')

    const reporter = new SummaryReporter()
    reporter.onTestBegin(mkTest('Fresh', '/specs/fresh.spec.ts', 1))

    expect(readSummary().failed).toEqual([])
  })

  it('preserves existing results while a targeted rerun is running', () => {
    process.env.CANARY_LAB_TARGETED_RERUN = '1'
    fs.mkdirSync(LOGS_DIR, { recursive: true })
    fs.writeFileSync(
      path.join(LOGS_DIR, 'e2e-summary.json'),
      JSON.stringify({
        complete: false,
        total: 2,
        passed: 1,
        passedNames: ['test-case-happy-path'],
        failed: [
          {
            name: 'test-case-sad-path',
            error: { message: 'old fail' },
            durationMs: 12,
            location: '/specs/sad.spec.ts:9',
            retry: 0,
            logFiles: ['logs/runs/run-1/failed/test-case-sad-path/svc-api.log'],
          },
        ],
      }),
    )

    const reporter = new SummaryReporter()
    reporter.onTestBegin(mkTest('Sad path', '/specs/sad.spec.ts', 9))

    expect(readSummary()).toMatchObject({
      complete: false,
      total: 2,
      passed: 1,
      passedNames: ['test-case-happy-path'],
      running: {
        name: 'test-case-sad-path',
        location: '/specs/sad.spec.ts:9',
      },
      failed: [
        {
          name: 'test-case-sad-path',
          error: { message: 'old fail' },
          durationMs: 12,
          location: '/specs/sad.spec.ts:9',
          retry: 0,
          logFiles: ['logs/runs/run-1/failed/test-case-sad-path/svc-api.log'],
        },
      ],
    })
  })

  it('merges a targeted rerun pass without resetting non-rerun statuses', () => {
    process.env.CANARY_LAB_TARGETED_RERUN = '1'
    fs.mkdirSync(LOGS_DIR, { recursive: true })
    fs.writeFileSync(
      path.join(LOGS_DIR, 'e2e-summary.json'),
      JSON.stringify({
        complete: false,
        total: 2,
        passed: 1,
        passedNames: ['test-case-happy-path'],
        failed: [{ name: 'test-case-sad-path', error: { message: 'old fail' }, durationMs: 12, location: '/specs/sad.spec.ts:9', retry: 0 }],
      }),
    )

    const reporter = new SummaryReporter()
    reporter.onTestBegin(mkTest('Sad path', '/specs/sad.spec.ts', 9))
    reporter.onTestEnd(mkTest('Sad path', '/specs/sad.spec.ts', 9), mkResult({ status: 'passed', duration: 22 }))
    reporter.onEnd({} as any)

    expect(readSummary()).toEqual({
      complete: true,
      total: 2,
      passed: 2,
      passedNames: ['test-case-happy-path', 'test-case-sad-path'],
      passedIds: [expect.any(String)],
      failed: [],
    })
  })

  it('updates the latest pending journal outcome on a successful targeted rerun end', () => {
    process.env.CANARY_LAB_TARGETED_RERUN = '1'
    fs.mkdirSync(LOGS_DIR, { recursive: true })
    fs.writeFileSync(path.join(LOGS_DIR, 'manifest.json'), JSON.stringify({ runId: 'run-1' }))
    fs.writeFileSync(
      path.join(LOGS_DIR, 'diagnosis-journal.md'),
      `# Diagnosis Journal

## Iteration 1 — t1

- run: run-1
- hypothesis: fix sad path
- outcome: pending
`,
    )
    fs.writeFileSync(
      path.join(LOGS_DIR, 'e2e-summary.json'),
      JSON.stringify({
        complete: false,
        total: 1,
        passed: 0,
        passedNames: [],
        failed: [{ name: 'test-case-sad-path', error: { message: 'old fail' } }],
      }),
    )

    const reporter = new SummaryReporter()
    reporter.onTestEnd(mkTest('Sad path'), mkResult({ status: 'passed' }))
    reporter.onEnd({} as any)

    expect(fs.readFileSync(path.join(LOGS_DIR, 'diagnosis-journal.md'), 'utf-8'))
      .toContain('- outcome: all_passed')
  })

  it('updates the latest pending journal outcome on a failed targeted rerun end', () => {
    process.env.CANARY_LAB_TARGETED_RERUN = '1'
    fs.mkdirSync(LOGS_DIR, { recursive: true })
    fs.writeFileSync(path.join(LOGS_DIR, 'manifest.json'), JSON.stringify({ runId: 'run-1' }))
    fs.writeFileSync(
      path.join(LOGS_DIR, 'diagnosis-journal.md'),
      `# Diagnosis Journal

## Iteration 1 — t1

- run: run-1
- hypothesis: old
- outcome: pending

## Iteration 2 — t2

- run: run-1
- hypothesis: latest
- outcome: pending
`,
    )
    fs.writeFileSync(
      path.join(LOGS_DIR, 'e2e-summary.json'),
      JSON.stringify({
        complete: false,
        total: 2,
        passed: 0,
        passedNames: [],
        failed: [
          { name: 'test-case-sad-path', error: { message: 'old sad fail' } },
          { name: 'test-case-other-path', error: { message: 'old other fail' } },
        ],
      }),
    )

    const reporter = new SummaryReporter()
    reporter.onTestEnd(mkTest('Sad path'), mkResult({ status: 'passed' }))
    reporter.onEnd({} as any)

    const journal = fs.readFileSync(path.join(LOGS_DIR, 'diagnosis-journal.md'), 'utf-8')
    expect(journal).toContain('## Iteration 1 — t1\n\n- run: run-1\n- hypothesis: old\n- outcome: pending')
    expect(journal).toContain('## Iteration 2 — t2\n\n- run: run-1\n- hypothesis: latest\n- outcome: partial')
  })

  it('updates only the rerun failure while preserving unrelated targeted-rerun statuses', () => {
    process.env.CANARY_LAB_TARGETED_RERUN = '1'
    fs.mkdirSync(LOGS_DIR, { recursive: true })
    fs.writeFileSync(
      path.join(LOGS_DIR, 'e2e-summary.json'),
      JSON.stringify({
        complete: false,
        total: 3,
        passed: 1,
        passedNames: ['test-case-happy-path'],
        failed: [
          {
            name: 'test-case-still-broken',
            error: { message: 'old still broken' },
            durationMs: 10,
            location: '/specs/still.spec.ts:4',
            retry: 0,
            logFiles: ['logs/runs/run-1/failed/test-case-still-broken/svc.log'],
          },
          {
            name: 'test-case-sad-path',
            error: { message: 'old sad fail' },
            durationMs: 12,
            location: '/specs/sad.spec.ts:9',
            retry: 0,
            logFiles: ['logs/runs/run-1/failed/test-case-sad-path/old.log'],
          },
        ],
      }),
    )

    const reporter = new SummaryReporter()
    reporter.onTestEnd(
      mkTest('Sad path', '/specs/sad.spec.ts', 9),
      mkResult({ status: 'failed', duration: 33, retry: 1, error: { message: 'new sad fail' } }),
    )

    expect(readSummary()).toEqual({
      complete: false,
      total: 3,
      passed: 1,
      passedNames: ['test-case-happy-path'],
      failed: [
        {
          name: 'test-case-still-broken',
          error: { message: 'old still broken' },
          durationMs: 10,
          location: '/specs/still.spec.ts:4',
          retry: 0,
          logFiles: ['logs/runs/run-1/failed/test-case-still-broken/svc.log'],
        },
        {
          id: expect.any(String),
          name: 'test-case-sad-path',
          error: { message: 'new sad fail' },
          durationMs: 33,
          location: '/specs/sad.spec.ts:9',
          retry: 1,
        },
      ],
    })
  })

  it('does not merge an existing summary during a full-suite run', () => {
    fs.mkdirSync(LOGS_DIR, { recursive: true })
    fs.writeFileSync(
      path.join(LOGS_DIR, 'e2e-summary.json'),
      JSON.stringify({
        complete: true,
        total: 1,
        passed: 1,
        passedNames: ['test-case-old-pass'],
        failed: [],
      }),
    )

    const reporter = new SummaryReporter()
    reporter.onTestEnd(mkTest('New pass'), mkResult())

    expect(readSummary()).toEqual({
      complete: false,
      total: 1,
      passed: 1,
      passedNames: ['test-case-new-pass'],
      passedIds: [expect.any(String)],
      failed: [],
    })
  })

  it('ignores unreadable targeted-rerun summaries', () => {
    process.env.CANARY_LAB_TARGETED_RERUN = '1'
    fs.mkdirSync(LOGS_DIR, { recursive: true })
    fs.writeFileSync(path.join(LOGS_DIR, 'e2e-summary.json'), '{not-json')

    const reporter = new SummaryReporter()
    reporter.onTestEnd(mkTest('New pass'), mkResult())

    expect(readSummary()).toEqual({
      complete: false,
      total: 1,
      passed: 1,
      passedNames: ['test-case-new-pass'],
      passedIds: [expect.any(String)],
      failed: [],
    })
  })

  it('filters malformed entries from targeted-rerun summaries', () => {
    process.env.CANARY_LAB_TARGETED_RERUN = '1'
    fs.mkdirSync(LOGS_DIR, { recursive: true })
    fs.writeFileSync(
      path.join(LOGS_DIR, 'e2e-summary.json'),
      JSON.stringify({
        passedNames: [
          'test-case-existing-pass',
          '',
          123,
          'test-case-existing-pass',
        ],
        failed: [
          null,
          42,
          { name: '' },
          { name: 'test-case-existing-pass', error: { message: 'duplicate' } },
          { name: 'test-case-bad-error', error: { message: 123 }, logFiles: [1, false] },
          { name: 'test-case-good-error', error: { message: 'boom', snippet: 'line' }, logFiles: ['a.log', 1] },
        ],
      }),
    )

    const reporter = new SummaryReporter()
    reporter.onEnd({} as any)

    expect(readSummary()).toEqual({
      complete: true,
      total: 3,
      passed: 1,
      passedNames: ['test-case-existing-pass'],
      failed: [
        { name: 'test-case-bad-error', logFiles: [] },
        { name: 'test-case-good-error', error: { message: 'boom', snippet: 'line' }, logFiles: ['a.log'] },
      ],
    })
  })

  it('clears the running test when the run ends without a matching test end', () => {
    const reporter = new SummaryReporter()
    reporter.onTestBegin(mkTest('Interrupted', '/specs/busy.spec.ts', 7))

    reporter.onEnd({} as any)

    expect(readSummary()).toEqual({
      complete: true,
      total: 0,
      passed: 0,
      passedNames: [],
      failed: [],
    })
  })

  it('adds trace summaries to failed entries and rewrites the heal index on end', async () => {
    fs.mkdirSync(LOGS_DIR, { recursive: true })
    const traceZip = path.join(LOGS_DIR, 'trace.zip')
    fs.writeFileSync(traceZip, 'zip')
    traceMocks.extractTraceSummary.mockResolvedValue({
      summaryPath: path.join(LOGS_DIR, 'failed', 'test-case-traced-fail', 'trace-extract', 'failure-summary.md'),
      bytes: 120,
      failedActionId: '4',
    })
    const reporter = new SummaryReporter()

    reporter.onTestEnd(
      mkTest('Traced fail', '/specs/traced.spec.ts', 6),
      mkResult({
        status: 'failed',
        error: { message: 'boom' },
        attachments: [
          { name: 'screenshot', path: path.join(LOGS_DIR, 'shot.png'), contentType: 'image/png' },
          { name: 'trace', path: traceZip, contentType: 'application/zip' },
        ],
      }),
    )
    await reporter.onEnd({} as any)

    expect(traceMocks.extractTraceSummary).toHaveBeenCalledWith({
      traceZipPath: traceZip,
      outputDir: path.join(LOGS_DIR, 'failed', 'test-case-traced-fail', 'trace-extract'),
      testName: 'test-case-traced-fail',
    })
    expect(readSummary().failed[0]).toMatchObject({
      name: 'test-case-traced-fail',
      traceSummaryFile: path.join('failed', 'test-case-traced-fail', 'trace-extract', 'failure-summary.md'),
    })
  })

  it('keeps final summaries when one trace extraction fails and another succeeds', async () => {
    fs.mkdirSync(LOGS_DIR, { recursive: true })
    const traceA = path.join(LOGS_DIR, 'trace-a.zip')
    const traceB = path.join(LOGS_DIR, 'trace-b.zip')
    fs.writeFileSync(traceA, 'zip')
    fs.writeFileSync(traceB, 'zip')
    traceMocks.extractTraceSummary
      .mockRejectedValueOnce(new Error('trace failed'))
      .mockResolvedValueOnce({
        summaryPath: path.join(LOGS_DIR, 'failed', 'different-test', 'trace-extract', 'failure-summary.md'),
        bytes: 20,
        failedActionId: null,
      })
    const reporter = new SummaryReporter()

    reporter.onTestEnd(
      mkTest('First fail'),
      mkResult({
        status: 'failed',
        error: { message: 'first' },
        attachments: [{ name: 'trace', path: traceA }],
      }),
    )
    reporter.onTestEnd(
      mkTest('Second fail'),
      mkResult({
        status: 'failed',
        error: { message: 'second' },
        attachments: [{ name: 'trace', path: traceB }],
      }),
    )
    await reporter.onEnd({} as any)

    expect(traceMocks.extractTraceSummary).toHaveBeenCalledTimes(2)
    expect(readSummary().failed.map((entry) => entry.traceSummaryFile)).toEqual([
      undefined,
      path.join('failed', 'different-test', 'trace-extract', 'failure-summary.md'),
    ])
  })

  it('leaves failed entries unchanged when every trace extraction fails', async () => {
    fs.mkdirSync(LOGS_DIR, { recursive: true })
    const traceZip = path.join(LOGS_DIR, 'trace.zip')
    fs.writeFileSync(traceZip, 'zip')
    traceMocks.extractTraceSummary.mockRejectedValue(new Error('trace failed'))
    const reporter = new SummaryReporter()

    reporter.onTestEnd(
      mkTest('Trace fail'),
      mkResult({
        status: 'failed',
        error: { message: 'boom' },
        attachments: [{ name: 'trace', path: traceZip }],
      }),
    )
    await reporter.onEnd({} as any)

    expect(readSummary().failed[0]).toEqual({
      id: expect.any(String),
      name: 'test-case-trace-fail',
      error: { message: 'boom' },
      durationMs: 42,
      location: '/spec.ts:1',
      retry: 0,
    })
  })

  it('rewrites heal-index with trace summaries when service logs are present', async () => {
    const runDir = LOGS_DIR
    fs.mkdirSync(runDir, { recursive: true })
    const svcLog = path.join(runDir, 'svc-api.log')
    const slugA = 'test-case-traced-w-logs'
    const slugB = 'test-case-no-trace'
    fs.writeFileSync(
      svcLog,
      `start\n<${slugA}>\nlate boom\n</${slugA}>\n<${slugB}>\nother boom\n</${slugB}>\nend\n`,
    )
    fs.writeFileSync(
      path.join(runDir, 'manifest.json'),
      JSON.stringify({ services: [{ logPath: svcLog }], feature: 'checkout' }),
    )
    const traceZip = path.join(runDir, 'trace.zip')
    fs.writeFileSync(traceZip, 'zip')
    traceMocks.extractTraceSummary.mockResolvedValue({
      summaryPath: path.join(runDir, 'failed', slugA, 'trace-extract', 'failure-summary.md'),
      bytes: 12,
      failedActionId: '1',
    })
    const reporter = new SummaryReporter()
    reporter.onTestEnd(
      mkTest('Traced w logs', '/specs/x.spec.ts', 6),
      mkResult({
        status: 'failed',
        error: { message: 'boom' },
        attachments: [{ name: 'trace', path: traceZip }],
      }),
    )
    // Second failure has no trace attachment → no traceSummaryFile.
    reporter.onTestEnd(
      mkTest('No trace', '/specs/y.spec.ts', 4),
      mkResult({ status: 'failed', error: { message: 'no trace' } }),
    )
    await reporter.onEnd({} as any)
    const out = readSummary()
    const traced = out.failed.find((e: any) => e.name === slugA)
    const noTrace = out.failed.find((e: any) => e.name === slugB)
    expect(traced.traceSummaryFile).toContain('failure-summary.md')
    expect(noTrace.traceSummaryFile).toBeUndefined()
  })

  it('records a step end with no locations and no error', () => {
    const reporter = new SummaryReporter()
    const test = mkTest('Step end no loc', '/specs/no-loc.spec.ts', 3)
    const step = mkStep('expect', 'expect')
    reporter.onTestBegin(test)
    reporter.onStepBegin(test, mkResult(), step)
    // step.error absent and no locations → both conditions false
    reporter.onStepEnd(test, mkResult(), step)
    reporter.onTestEnd(test, mkResult({ status: 'failed', error: { message: 'x' } }))
    const summary = readSummary()
    expect(summary.failed[0].locations).toBeUndefined()
  })

  it('records a failed step with no location without persisting failed step locations', () => {
    const reporter = new SummaryReporter()
    const test = mkTest('Step err no loc', '/specs/err.spec.ts', 3)
    const step = mkStep('expect', 'expect')
    reporter.onTestBegin(test)
    reporter.onStepBegin(test, mkResult(), step)
    // step.error truthy but step has no location → locs.length === 0 path
    reporter.onStepEnd(test, mkResult(), { ...step, error: { message: 'step failed' } })
    reporter.onTestEnd(test, mkResult({ status: 'failed', error: { message: 'x' } }))
    const summary = readSummary()
    expect(summary.failed[0].locations).toBeUndefined()
  })

  it('preserves an existing titlePath when a later entry has none', () => {
    fs.mkdirSync(LOGS_DIR, { recursive: true })
    fs.writeFileSync(
      path.join(LOGS_DIR, 'e2e-summary.json'),
      JSON.stringify({
        complete: true,
        knownTests: [
          { name: 'test-case-keep-path', title: 'keep path', titlePath: ['outer', 'keep path'] },
          { name: 'test-case-keep-path', title: 'keep path' },
        ],
        passedNames: [],
        failed: [],
      }),
    )
    const reporter = new SummaryReporter()
    reporter.onEnd({} as any)
    const out = readSummary()
    expect(out.knownTests[0].titlePath).toEqual(['outer', 'keep path'])
  })

  it('writes the currently running step location and keeps the test running when the step ends', () => {
    const reporter = new SummaryReporter()
    const test = mkTest('Currently busy', '/specs/busy.spec.ts', 7)
    const step = mkStep('expect(locator).toBeVisible', 'expect', '/specs/busy.spec.ts', 12)
    reporter.onTestBegin(test)
    reporter.onStepBegin(test, mkResult(), step)

    expect(readSummary().running).toEqual({
      id: expect.any(String),
      name: 'test-case-currently-busy',
      location: '/specs/busy.spec.ts:7',
      step: {
        title: 'expect(locator).toBeVisible',
        category: 'expect',
        location: '/specs/busy.spec.ts:12',
        locations: ['/specs/busy.spec.ts:12'],
      },
    })

    reporter.onStepEnd(test, mkResult(), step)
    expect(readSummary().running).toEqual({
      id: expect.any(String),
      name: 'test-case-currently-busy',
      location: '/specs/busy.spec.ts:7',
    })
  })

  it('keeps parallel worker step state isolated per running test', () => {
    const reporter = new SummaryReporter()
    const first = mkTest('First worker', '/specs/first.spec.ts', 7)
    const second = mkTest('Second worker', '/specs/second.spec.ts', 11)
    const firstStep = mkStep('first setup', 'test.step', '/specs/first.spec.ts', 8)
    const secondStep = mkStep('second setup', 'test.step', '/specs/second.spec.ts', 12)

    reporter.onTestBegin(first)
    reporter.onTestBegin(second)
    reporter.onStepBegin(first, mkResult(), firstStep)
    reporter.onStepBegin(second, mkResult(), secondStep)
    reporter.onStepEnd(first, mkResult(), firstStep)

    expect(readSummary().runningTests).toEqual([
      {
        id: expect.any(String),
        name: 'test-case-first-worker',
        location: '/specs/first.spec.ts:7',
      },
      {
        id: expect.any(String),
        name: 'test-case-second-worker',
        location: '/specs/second.spec.ts:11',
        step: {
          title: 'second setup',
          category: 'test.step',
          location: '/specs/second.spec.ts:12',
          locations: ['/specs/second.spec.ts:12'],
        },
      },
    ])
  })

  it('starts running state from a step event when begin was missed', () => {
    const reporter = new SummaryReporter()
    const test = mkTest('Late begin', '/specs/late.spec.ts', 3)
    reporter.onStepBegin(test, mkResult(), mkStep('setup', 'fixture'))

    expect(readSummary().running).toEqual({
      id: expect.any(String),
      name: 'test-case-late-begin',
      location: '/specs/late.spec.ts:3',
      step: { title: 'setup', category: 'fixture' },
    })
  })

  it('ignores step-end events for a different running test or unknown step', () => {
    const reporter = new SummaryReporter()
    const test = mkTest('Busy', '/specs/busy.spec.ts', 7)
    reporter.onTestBegin(test)
    reporter.onStepBegin(test, mkResult(), mkStep('known', 'test.step'))

    reporter.onStepEnd(mkTest('Other'), mkResult(), mkStep('known', 'test.step'))
    expect(readSummary().running.step).toEqual({ title: 'known', category: 'test.step' })

    reporter.onStepEnd(test, mkResult(), mkStep('unknown', 'test.step'))
    expect(readSummary().running.step).toEqual({ title: 'known', category: 'test.step' })
  })

  it('falls back to the parent step when a nested step ends', () => {
    const reporter = new SummaryReporter()
    const test = mkTest('Nested busy', '/specs/nested.spec.ts', 20)
    const parent = mkStep('Redeem voucher', 'test.step', '/specs/nested.spec.ts', 25)
    const child = mkStep('locator.click', 'pw:api', '/specs/nested.spec.ts', 28)
    reporter.onTestBegin(test)
    reporter.onStepBegin(test, mkResult(), parent)
    reporter.onStepBegin(test, mkResult(), child)
    reporter.onStepEnd(test, mkResult(), child)

    expect(readSummary().running.step).toEqual({
      title: 'Redeem voucher',
      category: 'test.step',
      location: '/specs/nested.spec.ts:25',
      locations: ['/specs/nested.spec.ts:25'],
    })
  })

  it('includes parent step locations so the UI can prefer in-spec call sites', () => {
    const reporter = new SummaryReporter()
    const test = mkTest('Nested busy', '/specs/nested.spec.ts', 20)
    const parent = mkStep('Redeem voucher', 'test.step', '/specs/nested.spec.ts', 25)
    const child = mkChildStep('locator.click', 'pw:api', parent, '/helpers/voucher.ts', 8)
    reporter.onTestBegin(test)
    reporter.onStepBegin(test, mkResult(), child)

    expect(readSummary().running.step).toMatchObject({
      title: 'locator.click',
      category: 'pw:api',
      location: '/helpers/voucher.ts:8',
      locations: ['/helpers/voucher.ts:8', '/specs/nested.spec.ts:25'],
    })
  })

  it('persists failed error and parent step locations for code highlighting', () => {
    const reporter = new SummaryReporter()
    const test = mkTest('Nested failure', '/specs/nested.spec.ts', 20)
    const parent = mkStep('Redeem voucher', 'test.step', '/specs/nested.spec.ts', 25)
    const child = mkChildStep('locator.click', 'pw:api', parent, '/helpers/voucher.ts', 8)

    reporter.onTestBegin(test)
    reporter.onStepBegin(test, mkResult(), parent)
    reporter.onStepBegin(test, mkResult(), child)
    reporter.onStepEnd(test, mkResult(), { ...child, error: { message: 'boom' } })
    reporter.onTestEnd(
      test,
      mkResult({
        status: 'failed',
        error: {
          message: 'boom',
          location: { file: '/helpers/voucher.ts', line: 8 },
          stack: [
            'Error: boom',
            '    at redeem (/helpers/voucher.ts:8:3)',
            '    at /specs/nested.spec.ts:25:5',
          ].join('\n'),
        },
        errors: [
          {
            message: 'boom',
            location: { file: '/helpers/voucher.ts', line: 8 },
            stack: [
              'Error: boom',
              '    at redeem (/helpers/voucher.ts:8:3)',
              '    at /specs/nested.spec.ts:25:5',
            ].join('\n'),
          },
        ],
      }),
    )

    expect(readSummary().failed[0]).toMatchObject({
      name: 'test-case-nested-failure',
      location: '/specs/nested.spec.ts:20',
      locations: ['/helpers/voucher.ts:8', '/specs/nested.spec.ts:25'],
    })
  })

  it('writes structured playback events with attachments', () => {
    const reporter = new SummaryReporter()
    const test = mkTest('Visual checkout', '/specs/checkout.spec.ts', 12)
    const step = mkStep('page.click', 'pw:api', '/specs/checkout.spec.ts', 18)

    reporter.onTestBegin(test)
    reporter.onStepBegin(test, mkResult(), step)
    reporter.onStepEnd(test, mkResult(), step)
    reporter.onTestEnd(
      test,
      mkResult({
        status: 'failed',
        duration: 123,
        retry: 1,
        error: { message: 'boom' },
        attachments: [
          { name: 'screenshot', contentType: 'image/png', path: '/tmp/run/playwright-artifacts/a/test-failed-1.png' },
          { name: 'trace', contentType: 'application/zip', path: '/tmp/run/playwright-artifacts/a/trace.zip' },
        ],
      }),
    )

    expect(readEvents()).toMatchObject([
      { type: 'test-begin', test: { name: 'test-case-visual-checkout', title: 'Visual checkout' } },
      { type: 'step-begin', step: { title: 'page.click', category: 'pw:api' } },
      { type: 'step-end', step: { title: 'page.click', category: 'pw:api' } },
      {
        type: 'test-end',
        test: { name: 'test-case-visual-checkout', title: 'Visual checkout' },
        status: 'failed',
        passed: false,
        durationMs: 123,
        retry: 1,
        attachments: [
          { name: 'screenshot', contentType: 'image/png', path: '/tmp/run/playwright-artifacts/a/test-failed-1.png' },
          { name: 'trace', contentType: 'application/zip', path: '/tmp/run/playwright-artifacts/a/trace.zip' },
        ],
      },
    ])
  })

  it('keeps attachment entries when Playwright only provides a name', () => {
    const reporter = new SummaryReporter()
    reporter.onTestBegin(mkTest('Minimal attachment', '/specs/min.spec.ts', 8))
    reporter.onTestEnd(
      mkTest('Minimal attachment', '/specs/min.spec.ts', 8),
      mkResult({
        status: 'failed',
        attachments: [{ name: 'stdout' }],
      }),
    )

    expect(readEvents().at(-1)).toMatchObject({
      type: 'test-end',
      attachments: [{ name: 'stdout' }],
    })
  })

  it('writes log slices and heal-index for failures', () => {
    const runDir = path.join(LOGS_DIR, 'runs', 'run-1')
    fs.mkdirSync(runDir, { recursive: true })
    process.env.CANARY_LAB_SUMMARY_PATH = path.join(runDir, 'e2e-summary.json')
    const svcLog = path.join(runDir, 'svc-api.log')
    const slug = 'test-case-broken-checkout'
    fs.writeFileSync(
      svcLog,
      `before\n<${slug}>\nERROR boom\n</${slug}>\nafter\n`,
    )
    fs.writeFileSync(
      path.join(runDir, 'manifest.json'),
      JSON.stringify({ services: [{ logPath: svcLog }], feature: 'checkout' }),
    )

    const reporter = new SummaryReporter()
    reporter.onTestEnd(
      mkTest('broken checkout'),
      mkResult({ status: 'failed', error: { message: 'nope' } }),
    )

    const out = JSON.parse(fs.readFileSync(path.join(runDir, 'e2e-summary.json'), 'utf-8'))
    expect(out.failed[0].logFiles).toEqual([`logs/runs/run-1/failed/${slug}/svc-api.log`])
    expect(fs.readFileSync(path.join(runDir, 'failed', slug, 'svc-api.log'), 'utf-8')).toBe(
      'ERROR boom',
    )
    expect(fs.readFileSync(path.join(runDir, 'heal-index.md'), 'utf-8')).toContain(slug)
  })

  it('writes a failed entry without error details when Playwright omits error', () => {
    const reporter = new SummaryReporter()
    reporter.onTestEnd(mkTest('silent fail'), mkResult({ status: 'timedOut' }))

    expect(readSummary().failed[0]).toEqual({
      id: expect.any(String),
      name: 'test-case-silent-fail',
      durationMs: 42,
      location: '/spec.ts:1',
      retry: 0,
    })
  })

  it('keeps skipped tests out of failed results', () => {
    const reporter = new SummaryReporter()
    reporter.onTestEnd(mkTest('Skipped branch'), mkResult({ status: 'skipped' }))

    expect(readSummary()).toEqual({
      complete: false,
      total: 1,
      passed: 0,
      passedNames: [],
      skipped: 1,
      skippedNames: ['test-case-skipped-branch'],
      skippedIds: [expect.any(String)],
      failed: [],
    })
  })

  it('skips enrichment in baseline benchmark mode', () => {
    process.env.CANARY_LAB_BENCHMARK_MODE = 'baseline'
    fs.mkdirSync(LOGS_DIR, { recursive: true })
    fs.writeFileSync(path.join(LOGS_DIR, 'manifest.json'), JSON.stringify({ serviceLogs: [] }))

    const reporter = new SummaryReporter()
    reporter.onTestEnd(mkTest('x'), mkResult({ status: 'failed' }))
    reporter.onEnd({} as any)

    expect(fs.existsSync(path.join(LOGS_DIR, 'heal-index.md'))).toBe(false)
    expect(readSummary().failed[0].logFiles).toBeUndefined()
  })

  it('seeds knownTests from an existing summary, filtering bad entries and merging duplicates', () => {
    fs.mkdirSync(LOGS_DIR, { recursive: true })
    fs.writeFileSync(
      path.join(LOGS_DIR, 'e2e-summary.json'),
      JSON.stringify({
        complete: true,
        knownTests: [
          null,
          'string-entry',
          { title: 'missing name' },
          { name: 'bad', title: '' },
          { name: '', title: 'bad title' },
          {
            name: 'test-case-rich',
            title: 'rich',
            titlePath: ['outer', '', 7, 'inner'],
            location: '/r.spec.ts:11',
          },
          {
            name: 'test-case-empty-loc',
            title: 'empty loc',
            titlePath: 'not-array',
            location: '',
          },
          { name: 'test-case-rich', title: 'rich override', location: '/r.spec.ts:12' },
        ],
        passedNames: [],
        failed: [],
      }),
    )

    const reporter = new SummaryReporter()
    reporter.onBegin({} as any, {
      allTests: () => [
        { ...mkTest('rich override', '/r.spec.ts', 12), titlePath: () => ['outer', 'inner'] },
      ],
    } as any)
    reporter.onEnd({} as any)

    const out = readSummary()
    expect(out.knownTests).toEqual([
      { id: expect.any(String), name: 'test-case-rich-override', title: 'rich override', titlePath: ['outer', 'inner'], location: '/r.spec.ts:12' },
      { id: expect.any(String), name: 'test-case-empty-loc', title: 'empty loc' },
    ])
  })

  it('uses computed location fallback when known.location is unset', () => {
    const reporter = new SummaryReporter()
    const test = { title: 'no loc', location: { file: '', line: 7 } } as any
    reporter.onTestBegin(test)
    expect(readSummary().running).toEqual({ id: expect.any(String), name: 'test-case-no-loc', location: ':7' })
    reporter.onTestEnd(test, mkResult())
    expect(readSummary()).toMatchObject({
      passedNames: ['test-case-no-loc'],
    })
    // playback event also exercises the same fallback in onTestEnd
    const events = readEvents()
    expect(events.at(-1)).toMatchObject({ type: 'test-end', test: { location: ':7' } })
  })

  it('does not decrement failureCount when removing a non-failure result', () => {
    process.env.CANARY_LAB_TARGETED_RERUN = '1'
    fs.mkdirSync(LOGS_DIR, { recursive: true })
    fs.writeFileSync(
      path.join(LOGS_DIR, 'e2e-summary.json'),
      JSON.stringify({
        passedNames: ['test-case-rerun-pass'],
        failed: [],
      }),
    )
    const reporter = new SummaryReporter()
    reporter.onTestEnd(mkTest('rerun pass', '/r.spec.ts', 4), mkResult())
    expect(readSummary().passedNames).toEqual(['test-case-rerun-pass'])
  })

  it('ignores non-array failed lists in existing summaries', () => {
    process.env.CANARY_LAB_TARGETED_RERUN = '1'
    fs.mkdirSync(LOGS_DIR, { recursive: true })
    fs.writeFileSync(
      path.join(LOGS_DIR, 'e2e-summary.json'),
      JSON.stringify({ passedNames: [], failed: 'nope' }),
    )
    const reporter = new SummaryReporter()
    reporter.onTestEnd(mkTest('fresh'), mkResult())
    expect(readSummary().passedNames).toEqual(['test-case-fresh'])
  })

  it('drops the location when the playwright TestCase omits file or line', () => {
    const reporter = new SummaryReporter()
    const test = { title: 'no loc', location: { file: '', line: 7 } } as any
    reporter.onTestEnd(test, mkResult())
    // No known location is rendered for the result entry
    expect(readSummary().passedNames).toEqual(['test-case-no-loc'])
  })

  it('skips reconcile when readExistingSummary returns null after a final write', () => {
    const reporter = new SummaryReporter()
    reporter.onTestEnd(mkTest('happy'), mkResult())
    const summaryPath = path.join(LOGS_DIR, 'e2e-summary.json')
    const real = fs.readFileSync
    const spy = vi.spyOn(fs, 'readFileSync').mockImplementation(((p: any, enc: any) => {
      if (String(p) === summaryPath) throw new Error('no summary')
      return (real as any)(p, enc)
    }) as typeof fs.readFileSync)
    try {
      reporter.onEnd({} as any)
    } finally {
      spy.mockRestore()
    }
    // onEnd still completes — final write happened first, reconcile silently bails.
    expect(readSummary().complete).toBe(true)
  })

  it('normalizes failure locations including non-matching paths and skips undefined entries', () => {
    const reporter = new SummaryReporter()
    reporter.onTestEnd(
      mkTest('weird stack', '/specs/x.spec.ts', 1),
      mkResult({
        status: 'failed',
        error: {
          message: 'boom',
          // Relative file path triggers the non-matching branch in normalizeLocation.
          location: { file: 'relative/foo.ts', line: 5 },
        },
        errors: [
          {
            location: undefined,
            stack: 'Error: boom\n    at fn (relative/path.ts:7:1)\n    at /abs/path.ts:9:2',
          },
        ],
      }),
    )
    const failed = readSummary().failed[0]
    expect(failed.locations).toEqual(['relative/foo.ts:5', '/abs/path.ts:9'])
  })

  it('runs final enrichment when failures were not enriched earlier', () => {
    process.env.CANARY_LAB_BENCHMARK_MODE = 'baseline'
    const runDir = path.join(LOGS_DIR, 'runs', 'run-final')
    fs.mkdirSync(runDir, { recursive: true })
    process.env.CANARY_LAB_SUMMARY_PATH = path.join(runDir, 'e2e-summary.json')
    const svcLog = path.join(runDir, 'svc-api.log')
    const slug = 'test-case-final-fail'
    fs.writeFileSync(svcLog, `before\n<${slug}>\nlate boom\n</${slug}>\nafter\n`)
    fs.writeFileSync(
      path.join(runDir, 'manifest.json'),
      JSON.stringify({ services: [{ logPath: svcLog }], feature: 'checkout' }),
    )

    const reporter = new SummaryReporter()
    reporter.onTestEnd(mkTest('final fail'), mkResult({ status: 'failed', error: { message: 'late' } }))
    delete process.env.CANARY_LAB_BENCHMARK_MODE
    reporter.onEnd({} as any)

    const out = JSON.parse(fs.readFileSync(path.join(runDir, 'e2e-summary.json'), 'utf-8'))
    expect(out.failed[0].logFiles).toEqual([`logs/runs/run-final/failed/${slug}/svc-api.log`])
    expect(fs.readFileSync(path.join(runDir, 'heal-index.md'), 'utf-8')).toContain(slug)
  })
})
