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
      // The happy-path pass is still the PRIOR execution's result, so the
      // summary must say its outcomes span more than one run.
      mergedFromPriorExecution: true,
      failed: [],
    })
  })

  it('carries a prior passed-on-retry marker through a merge, so a flaky pass never launders into a clean one', () => {
    process.env.CANARY_LAB_TARGETED_RERUN = '1'
    fs.mkdirSync(LOGS_DIR, { recursive: true })
    fs.writeFileSync(
      path.join(LOGS_DIR, 'e2e-summary.json'),
      JSON.stringify({
        complete: false,
        total: 2,
        passed: 2,
        passedNames: ['test-case-flaky-pass', 'test-case-clean-pass'],
        // The empty string and the number are hand-edit damage: only the real
        // name may survive into the merged marker.
        passedOnRetry: ['test-case-flaky-pass', '', 17],
        failed: [],
      }),
    )

    const reporter = new SummaryReporter()
    reporter.onEnd({} as any)

    const out = readSummary()
    expect(out.passedOnRetry).toEqual(['test-case-flaky-pass'])
    expect(out.mergedFromPriorExecution).toBe(true)
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
      mergedFromPriorExecution: true,
      failed: [
        { name: 'test-case-bad-error', logFiles: [] },
        { name: 'test-case-good-error', error: { message: 'boom', snippet: 'line' }, logFiles: ['a.log'] },
      ],
    })
  })

  it('drops the merged-execution flag once every seeded result has been re-run in this execution', () => {
    process.env.CANARY_LAB_TARGETED_RERUN = '1'
    fs.mkdirSync(LOGS_DIR, { recursive: true })
    fs.writeFileSync(
      path.join(LOGS_DIR, 'e2e-summary.json'),
      JSON.stringify({
        complete: false,
        total: 1,
        passed: 0,
        passedNames: [],
        failed: [{ name: 'test-case-sad-path', error: { message: 'old fail' }, location: '/specs/sad.spec.ts:9' }],
      }),
    )

    const reporter = new SummaryReporter()
    reporter.onTestEnd(mkTest('Sad path', '/specs/sad.spec.ts', 9), mkResult({ status: 'passed' }))
    reporter.onEnd({} as any)

    const out = readSummary()
    // Every result is now this execution's own observation — one clean run.
    expect(out.mergedFromPriorExecution).toBeUndefined()
    expect(out.passedNames).toEqual(['test-case-sad-path'])
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
})
