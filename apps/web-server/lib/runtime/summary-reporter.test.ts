import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-sr-')))
const LOGS_DIR = path.join(tmpRoot, 'logs')

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

const { slugify, default: SummaryReporter } = await import('./summary-reporter')

afterEach(() => {
  fs.rmSync(LOGS_DIR, { recursive: true, force: true })
  delete process.env.CANARY_LAB_SUMMARY_PATH
  delete process.env.CANARY_LAB_BENCHMARK_MODE
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
      failed: [
        {
          name: 'test-case-the-sad-test',
          error: { message: 'boom', snippet: 'expect(x).toBe(y)' },
          durationMs: 99,
          location: '/b.spec.ts:22',
          retry: 1,
        },
      ],
    })
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

  it('writes the currently running step location and keeps the test running when the step ends', () => {
    const reporter = new SummaryReporter()
    const test = mkTest('Currently busy', '/specs/busy.spec.ts', 7)
    const step = mkStep('expect(locator).toBeVisible', 'expect', '/specs/busy.spec.ts', 12)
    reporter.onTestBegin(test)
    reporter.onStepBegin(test, mkResult(), step)

    expect(readSummary().running).toEqual({
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
      name: 'test-case-currently-busy',
      location: '/specs/busy.spec.ts:7',
    })
  })

  it('starts running state from a step event when begin was missed', () => {
    const reporter = new SummaryReporter()
    const test = mkTest('Late begin', '/specs/late.spec.ts', 3)
    reporter.onStepBegin(test, mkResult(), mkStep('setup', 'fixture'))

    expect(readSummary().running).toEqual({
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

  it('writes log slices and heal-index for failures', () => {
    fs.mkdirSync(LOGS_DIR, { recursive: true })
    const svcLog = path.join(LOGS_DIR, 'api.log')
    const slug = 'test-case-broken-checkout'
    fs.writeFileSync(
      svcLog,
      `before\n<${slug}>\nERROR boom\n</${slug}>\nafter\n`,
    )
    fs.writeFileSync(
      path.join(LOGS_DIR, 'manifest.json'),
      JSON.stringify({ serviceLogs: [svcLog], featureName: 'checkout' }),
    )

    const reporter = new SummaryReporter()
    reporter.onTestEnd(
      mkTest('broken checkout'),
      mkResult({ status: 'failed', error: { message: 'nope' } }),
    )

    const out = readSummary()
    expect(out.failed[0].logFiles).toEqual([`logs/failed/${slug}/api.log`])
    expect(fs.readFileSync(path.join(LOGS_DIR, 'failed', slug, 'api.log'), 'utf-8')).toBe(
      'ERROR boom',
    )
    expect(fs.readFileSync(path.join(LOGS_DIR, 'heal-index.md'), 'utf-8')).toContain(slug)
  })

  it('writes a failed entry without error details when Playwright omits error', () => {
    const reporter = new SummaryReporter()
    reporter.onTestEnd(mkTest('silent fail'), mkResult({ status: 'timedOut' }))

    expect(readSummary().failed[0]).toEqual({
      name: 'test-case-silent-fail',
      durationMs: 42,
      location: '/spec.ts:1',
      retry: 0,
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
})
