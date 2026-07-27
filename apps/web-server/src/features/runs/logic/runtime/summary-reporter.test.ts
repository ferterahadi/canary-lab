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
