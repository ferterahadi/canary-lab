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

describe('SummaryReporter', () => {
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

  it("copies Playwright's error-context attachment into failed/<slug>/ and records the path", () => {
    process.env.CANARY_LAB_BENCHMARK_MODE = 'baseline'
    const reporter = new SummaryReporter()
    // Stands in for the file Playwright writes into the test's output dir —
    // the dir the next `--output` invocation wipes, which is the whole reason
    // the reporter copies it out instead of pointing at it.
    const pwOutputDir = fs.mkdtempSync(path.join(tmpRoot, 'pw-output-'))
    const attachmentPath = path.join(pwOutputDir, 'error-context.md')
    fs.writeFileSync(attachmentPath, '# Page state\n- button "Checkout" [disabled]\n')

    reporter.onTestEnd(mkTest('checkout is enabled', '/specs/checkout.spec.ts', 12), mkResult({
      status: 'failed',
      error: { message: 'expected enabled' },
      attachments: [{ name: 'error-context', contentType: 'text/markdown', path: attachmentPath }],
    }))

    // Keyed off the entry's own slug so this stays pinned to the same
    // `failed/<slug>/` convention the trace extract and error.txt already use.
    const entry = readSummary().failed[0]
    const rel = path.join('failed', entry.name, 'error-context.md')
    expect(entry.errorContextFile).toBe(rel)
    expect(fs.readFileSync(path.join(LOGS_DIR, rel), 'utf-8')).toContain('button "Checkout" [disabled]')
    fs.rmSync(pwOutputDir, { recursive: true, force: true })
  })

  it('copies the fixture-recorded HAR into failed/<slug>/network.har', () => {
    process.env.CANARY_LAB_BENCHMARK_MODE = 'baseline'
    const reporter = new SummaryReporter()
    const pwOutputDir = fs.mkdtempSync(path.join(tmpRoot, 'pw-output-'))
    const attachmentPath = path.join(pwOutputDir, 'canary-lab-network-my-case.har')
    fs.writeFileSync(attachmentPath, '{"log":{"entries":[{"request":{"url":"/api/checkout"}}]}}')

    reporter.onTestEnd(mkTest('checkout posts the order', '/specs/checkout.spec.ts', 20), mkResult({
      status: 'failed',
      error: { message: 'expected 200' },
      attachments: [{ name: 'canary-lab-network-har', contentType: 'application/json', path: attachmentPath }],
    }))

    const entry = readSummary().failed[0]
    expect(entry.harFile).toBe(path.join('failed', entry.name, 'network.har'))
    expect(fs.readFileSync(path.join(LOGS_DIR, entry.harFile), 'utf-8')).toContain('/api/checkout')
    fs.rmSync(pwOutputDir, { recursive: true, force: true })
  })

  it('omits errorContextFile when the failure carried no error-context attachment', () => {
    process.env.CANARY_LAB_BENCHMARK_MODE = 'baseline'
    const reporter = new SummaryReporter()
    reporter.onTestEnd(mkTest('no context fail'), mkResult({
      status: 'failed',
      error: { message: 'boom' },
      attachments: [{ name: 'trace', path: '/tmp/trace.zip' }],
    }))
    expect(readSummary().failed[0].errorContextFile).toBeUndefined()
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

  it('drops the location when the playwright TestCase omits file or line', () => {
    const reporter = new SummaryReporter()
    const test = { title: 'no loc', location: { file: '', line: 7 } } as any
    reporter.onTestEnd(test, mkResult())
    // No known location is rendered for the result entry
    expect(readSummary().passedNames).toEqual(['test-case-no-loc'])
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
})
