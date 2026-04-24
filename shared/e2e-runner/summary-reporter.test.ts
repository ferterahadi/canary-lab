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
  MANIFEST_PATH: path.join(LOGS_DIR, 'manifest.json'),
  SUMMARY_PATH: path.join(LOGS_DIR, 'e2e-summary.json'),
  DIAGNOSIS_JOURNAL_PATH: path.join(LOGS_DIR, 'diagnosis-journal.md'),
  HEAL_INDEX_PATH: path.join(LOGS_DIR, 'heal-index.md'),
  FAILED_DIR: path.join(LOGS_DIR, 'failed'),
  RERUN_SIGNAL: path.join(LOGS_DIR, '.rerun'),
  RESTART_SIGNAL: path.join(LOGS_DIR, '.restart'),
  getSummaryPath: () =>
    process.env.CANARY_LAB_SUMMARY_PATH ?? path.join(LOGS_DIR, 'e2e-summary.json'),
}))

const { slugify, default: SummaryReporter } = await import('./summary-reporter')

afterEach(() => {
  fs.rmSync(LOGS_DIR, { recursive: true, force: true })
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
    expect(out.complete).toBe(true)
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

  it('strips ANSI escape codes before writing e2e-summary.json', () => {
    const r = new SummaryReporter()
    r.onTestEnd(
      mkTest('ANSI fail'),
      mkResult({
        status: 'failed',
        error: {
          message:
            'Error: \x1b[2mexpect(\x1b[22m\x1b[31mreceived\x1b[39m\x1b[2m).toBe(\x1b[22m\x1b[32mexpected\x1b[39m\x1b[2m)\x1b[22m Expected: [32m400[39m Received: [31m200[39m',
          snippet: '\x1b[31mreceived\x1b[39m [32mexpected[39m',
        },
      }),
    )
    r.onEnd({} as any)

    const out = JSON.parse(
      fs.readFileSync(path.join(LOGS_DIR, 'e2e-summary.json'), 'utf-8'),
    )
    expect(out.failed[0].error.message).toBe(
      'Error: expect(received).toBe(expected) Expected: 400 Received: 200',
    )
    expect(out.failed[0].error.snippet).toBe('received expected')
    expect(JSON.stringify(out)).not.toMatch(/\x1b\[/)
    expect(JSON.stringify(out)).not.toMatch(/\[\d+m/)
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
    expect(out).toEqual({ complete: true, total: 2, passed: 2, failed: [] })
  })

  it('creates LOGS_DIR if it does not exist', () => {
    fs.rmSync(LOGS_DIR, { recursive: true, force: true })
    const r = new SummaryReporter()
    r.onEnd({} as any)
    expect(fs.existsSync(path.join(LOGS_DIR, 'e2e-summary.json'))).toBe(true)
  })

  it('writes a partial summary after onTestEnd before onEnd runs (complete: false)', () => {
    const r = new SummaryReporter()
    r.onTestEnd(mkTest('first one', '/a.spec.ts', 5), mkResult())
    const out = JSON.parse(
      fs.readFileSync(path.join(LOGS_DIR, 'e2e-summary.json'), 'utf-8'),
    )
    expect(out.complete).toBe(false)
    expect(out.total).toBe(1)
    expect(out.passed).toBe(1)
    expect(out.failed).toEqual([])
  })

  it('attaches logFiles paths (not embedded logs) and writes per-failure slice files + heal-index', () => {
    fs.mkdirSync(LOGS_DIR, { recursive: true })
    const svcLog = path.join(LOGS_DIR, 'api.log')
    const slug = 'test-case-broken-checkout'
    fs.writeFileSync(
      svcLog,
      `irrelevant prelude\n<${slug}>\nERROR boom at line 42\n</${slug}>\ntrailing noise\n`,
    )
    fs.writeFileSync(
      path.join(LOGS_DIR, 'manifest.json'),
      JSON.stringify({ serviceLogs: [svcLog] }),
    )

    const r = new SummaryReporter()
    r.onTestEnd(
      mkTest('broken checkout'),
      mkResult({ status: 'failed', error: { message: 'nope' } }),
    )

    const partial = JSON.parse(
      fs.readFileSync(path.join(LOGS_DIR, 'e2e-summary.json'), 'utf-8'),
    )
    expect(partial.complete).toBe(false)
    expect(partial.failed).toHaveLength(1)
    expect(partial.failed[0].name).toBe(slug)
    // Summary stays lean — no embedded log bodies.
    expect(partial.failed[0].logs).toBeUndefined()
    expect(partial.failed[0].logFiles).toEqual([`logs/failed/${slug}/api.log`])

    // Per-failure slice file exists with the extracted snippet.
    const slicePath = path.join(LOGS_DIR, 'failed', slug, 'api.log')
    expect(fs.readFileSync(slicePath, 'utf-8')).toBe('ERROR boom at line 42')

    // heal-index.md is the agent's entry point — written on every onTestEnd
    // so mid-run heal works if the user Ctrl+Cs. Cheap: no subprocesses.
    const indexPath = path.join(LOGS_DIR, 'heal-index.md')
    expect(fs.existsSync(indexPath)).toBe(true)
    const md = fs.readFileSync(indexPath, 'utf-8')
    expect(md).toContain('# Heal Index')
    expect(md).toContain(slug)
    expect(md).toContain(`slice: logs/failed/${slug}/api.log`)
    expect(md).not.toContain('target service:')
    expect(md).not.toContain('### Cluster')

    r.onEnd({} as any)
    const finalOut = JSON.parse(
      fs.readFileSync(path.join(LOGS_DIR, 'e2e-summary.json'), 'utf-8'),
    )
    expect(finalOut.complete).toBe(true)
    expect(finalOut.failed[0].logFiles).toEqual([`logs/failed/${slug}/api.log`])
  })

  it('skips enrichment and heal-index when running in baseline benchmark mode', () => {
    fs.mkdirSync(LOGS_DIR, { recursive: true })
    const svcLog = path.join(LOGS_DIR, 'api.log')
    fs.writeFileSync(svcLog, '<test-case-x>x</test-case-x>')
    fs.writeFileSync(
      path.join(LOGS_DIR, 'manifest.json'),
      JSON.stringify({ serviceLogs: [svcLog] }),
    )

    const original = process.env.CANARY_LAB_BENCHMARK_MODE
    process.env.CANARY_LAB_BENCHMARK_MODE = 'baseline'
    try {
      const r = new SummaryReporter()
      r.onTestEnd(mkTest('x'), mkResult({ status: 'failed' }))
      r.onEnd({} as any)
    } finally {
      if (original === undefined) {
        delete process.env.CANARY_LAB_BENCHMARK_MODE
      } else {
        process.env.CANARY_LAB_BENCHMARK_MODE = original
      }
    }

    expect(fs.existsSync(path.join(LOGS_DIR, 'heal-index.md'))).toBe(false)
    expect(fs.existsSync(path.join(LOGS_DIR, 'failed'))).toBe(false)
    const out = JSON.parse(
      fs.readFileSync(path.join(LOGS_DIR, 'e2e-summary.json'), 'utf-8'),
    )
    expect(out.failed[0].logFiles).toBeUndefined()
    expect(out.failed[0].logs).toBeUndefined()
  })
})
