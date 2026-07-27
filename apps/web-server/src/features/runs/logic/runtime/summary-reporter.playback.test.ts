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

describe('SummaryReporter', () => {
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
})
