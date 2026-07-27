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
    expect(readSummary().failed.map((entry: { traceSummaryFile?: string }) => entry.traceSummaryFile)).toEqual([
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
