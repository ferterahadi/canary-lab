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

  it('names a pass that needed a retry, so "every test passed" surfaces can caveat the flake', () => {
    const reporter = new SummaryReporter()
    // First attempt fails, the retry passes — Playwright reports both through
    // onTestEnd, and the last attempt wins the results list. Without the
    // passedOnRetry marker the summary would be indistinguishable from a
    // clean first-attempt pass.
    reporter.onTestEnd(
      mkTest('Flaky checkout', '/a.spec.ts', 5),
      mkResult({ status: 'failed', retry: 0, error: { message: 'boom' } }),
    )
    reporter.onTestEnd(mkTest('Flaky checkout', '/a.spec.ts', 5), mkResult({ status: 'passed', retry: 1 }))
    reporter.onTestEnd(mkTest('Clean pass', '/a.spec.ts', 9), mkResult({ status: 'passed', retry: 0 }))
    reporter.onEnd({} as any)

    const out = readSummary()
    expect(out.passedNames).toEqual(['test-case-flaky-checkout', 'test-case-clean-pass'])
    expect(out.passedOnRetry).toEqual(['test-case-flaky-checkout'])
    expect(out.mergedFromPriorExecution).toBeUndefined()
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

  it('strips ANSI noise; keeps the full error on the summary, trims only playback', () => {
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

    // Heal-facing summary keeps the FULL error (ANSI stripped, not length-capped):
    // the agent needs the complete assertion diff to diagnose.
    const out = readSummary()
    expect(out.failed[0].error.message).toHaveLength(1200)
    expect(out.failed[0].error.snippet).toHaveLength(700)
    expect(JSON.stringify(out)).not.toMatch(/\x1b\[/)

    // Playback (UI replay) keeps a bounded copy so playwright-events.jsonl stays small.
    const testEnd = readEvents().find((e) => e.type === 'test-end' && e.error)
    expect(testEnd.error.message).toHaveLength(1000)
    expect(testEnd.error.snippet).toHaveLength(500)
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
})

// `test.skip(condition, reason)` leaves a `skip` annotation carrying the reason;
// Playwright's own skips carry none. The summary must keep the two apart —
// `gatedNames` is what lets the verdict call an env-gated suite green — and a
// targeted rerun must not lose the distinction when it seeds the prior summary.
describe('SummaryReporter declared gates', () => {
  const gate = (title: string, reason?: string) => ({
    ...mkTest(title, '/meta.spec.ts', 4),
    annotations: [{ type: 'skip', ...(reason === undefined ? {} : { description: reason }) }],
  })

  it('records a reasoned self-skip as gated and every other skip as merely skipped', () => {
    const reporter = new SummaryReporter()
    reporter.onTestEnd(gate('Meta only', 'Real-Meta gate: runs only in the meta environment'), mkResult({ status: 'skipped' }))
    reporter.onTestEnd(gate('Silenced', ''), mkResult({ status: 'skipped' }))
    reporter.onTestEnd(mkTest('Serial remainder', '/a.spec.ts', 9), mkResult({ status: 'skipped' }))
    reporter.onTestEnd(gate('Ran anyway', 'stale annotation'), mkResult({ status: 'passed' }))
    reporter.onEnd({} as any)

    const out = readSummary()
    expect(out.skipped).toBe(3)
    expect(out.skippedNames).toEqual(['test-case-meta-only', 'test-case-silenced', 'test-case-serial-remainder'])
    expect(out.gatedNames).toEqual(['test-case-meta-only'])
    expect(out.gatedReasons).toEqual(['Real-Meta gate: runs only in the meta environment'])
    expect(out.gatedIds).toEqual([expect.any(String)])
    expect(out.passedNames).toEqual(['test-case-ran-anyway'])
  })

  it('omits the gated fields when no skip declared a reason', () => {
    const reporter = new SummaryReporter()
    reporter.onTestEnd(mkTest('Serial remainder', '/a.spec.ts', 9), mkResult({ status: 'skipped' }))
    reporter.onEnd({} as any)
    const out = readSummary()
    expect(out.skippedNames).toEqual(['test-case-serial-remainder'])
    expect(out).not.toHaveProperty('gatedNames')
  })

  it('keeps a prior execution’s gates declared when a targeted rerun seeds from it', () => {
    fs.mkdirSync(LOGS_DIR, { recursive: true })
    fs.writeFileSync(path.join(LOGS_DIR, 'e2e-summary.json'), JSON.stringify({
      complete: true,
      total: 3,
      passed: 1,
      passedNames: ['test-case-local'],
      skipped: 2,
      skippedNames: ['test-case-meta', 'test-case-remainder'],
      gatedNames: ['test-case-meta'],
      gatedReasons: ['Real-Meta gate'],
      failed: [{ name: 'test-case-flaky' }],
    }))
    process.env.CANARY_LAB_TARGETED_RERUN = '1'
    const reporter = new SummaryReporter()
    reporter.onTestEnd(mkTest('Flaky', '/a.spec.ts', 2), mkResult({ status: 'passed' }))
    reporter.onEnd({} as any)

    const out = readSummary()
    expect(out.passedNames).toEqual(expect.arrayContaining(['test-case-local', 'test-case-flaky']))
    expect(out.skippedNames).toEqual(['test-case-meta', 'test-case-remainder'])
    expect(out.gatedNames).toEqual(['test-case-meta'])
    expect(out.gatedReasons).toEqual(['Real-Meta gate'])
    expect(out.mergedFromPriorExecution).toBe(true)
  })
})
