import { describe, it, expect, vi, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const tmpDirs: string[] = []
function mkTmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-sr-'))
  tmpDirs.push(dir)
  return fs.realpathSync(dir)
}

const LOGS_DIR = path.join(mkTmp(), 'logs')
vi.mock('./paths', () => ({
  ROOT: path.dirname(LOGS_DIR),
  LOGS_DIR,
  RERUN_SIGNAL: path.join(LOGS_DIR, '.rerun'),
  RESTART_SIGNAL: path.join(LOGS_DIR, '.restart'),
}))

const { slugify, default: SummaryReporter } = await import('./summary-reporter')

afterEach(() => {
  if (fs.existsSync(path.join(LOGS_DIR, 'e2e-summary.json'))) {
    fs.unlinkSync(path.join(LOGS_DIR, 'e2e-summary.json'))
  }
  while (tmpDirs.length > 1) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true })
})

function mkTest(title: string, file = '/spec.ts', line = 1): any {
  return { title, location: { file, line } }
}

function mkResult(overrides: Partial<any> = {}): any {
  return { status: 'passed', duration: 42, retry: 0, ...overrides }
}

describe('slugify (summary-reporter)', () => {
  it('lowercases and replaces non-alphanumeric runs with a single dash', () => {
    expect(slugify('Hello World!')).toBe('hello-world')
    expect(slugify('UPPER CASE')).toBe('upper-case')
    expect(slugify('a  b   c')).toBe('a-b-c')
  })
  it('trims leading/trailing dashes', () => {
    expect(slugify('  hi  ')).toBe('hi')
    expect(slugify('!!hi!!')).toBe('hi')
  })
  it('preserves existing alphanumerics', () => {
    expect(slugify('version 1.2.3')).toBe('version-1-2-3')
  })
})

describe('SummaryReporter', () => {
  it('writes e2e-summary.json with passed/failed counts and failure details', () => {
    const r = new SummaryReporter()
    r.onTestEnd(mkTest('A happy test', '/a.spec.ts', 10), mkResult())
    r.onTestEnd(
      mkTest('The sad test', '/b.spec.ts', 22),
      mkResult({
        status: 'failed',
        duration: 99,
        retry: 1,
        error: { message: 'boom', snippet: 'expect(x).toBe(y)' },
      }),
    )
    r.onEnd({} as any)

    const out = JSON.parse(
      fs.readFileSync(path.join(LOGS_DIR, 'e2e-summary.json'), 'utf-8'),
    )
    expect(out.total).toBe(2)
    expect(out.passed).toBe(1)
    expect(out.failed).toEqual([
      {
        name: 'test-case-the-sad-test',
        error: { message: 'boom', snippet: 'expect(x).toBe(y)' },
        durationMs: 99,
        location: '/b.spec.ts:22',
        retry: 1,
      },
    ])
  })

  it('truncates very long error messages (1000) and snippets (500)', () => {
    const r = new SummaryReporter()
    const longMsg = 'x'.repeat(2000)
    const longSnip = 'y'.repeat(1000)
    r.onTestEnd(
      mkTest('Long fail'),
      mkResult({ status: 'failed', error: { message: longMsg, snippet: longSnip } }),
    )
    r.onEnd({} as any)
    const out = JSON.parse(
      fs.readFileSync(path.join(LOGS_DIR, 'e2e-summary.json'), 'utf-8'),
    )
    expect(out.failed[0].error.message).toHaveLength(1000)
    expect(out.failed[0].error.snippet).toHaveLength(500)
  })

  it('omits `error` when a failed test has no .error attached', () => {
    const r = new SummaryReporter()
    r.onTestEnd(mkTest('flaky'), mkResult({ status: 'failed' }))
    r.onEnd({} as any)
    const out = JSON.parse(
      fs.readFileSync(path.join(LOGS_DIR, 'e2e-summary.json'), 'utf-8'),
    )
    expect(out.failed[0]).not.toHaveProperty('error')
  })

  it('writes an empty failed array when all tests pass', () => {
    const r = new SummaryReporter()
    r.onTestEnd(mkTest('a'), mkResult())
    r.onTestEnd(mkTest('b'), mkResult())
    r.onEnd({} as any)
    const out = JSON.parse(
      fs.readFileSync(path.join(LOGS_DIR, 'e2e-summary.json'), 'utf-8'),
    )
    expect(out).toEqual({ total: 2, passed: 2, failed: [] })
  })

  it('creates LOGS_DIR if it does not exist', () => {
    fs.rmSync(LOGS_DIR, { recursive: true, force: true })
    const r = new SummaryReporter()
    r.onEnd({} as any)
    expect(fs.existsSync(path.join(LOGS_DIR, 'e2e-summary.json'))).toBe(true)
  })
})
