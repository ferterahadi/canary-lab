import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFile } from 'child_process'
import { extractTraceSummary, parseFirstFailedActionId } from './trace-enrichment'

vi.mock('child_process', () => ({
  execFile: vi.fn(),
}))

const execFileMock = vi.mocked(execFile)

describe('parseFirstFailedActionId', () => {
  it('returns the ordinal of the first failed row', () => {
    const stdout = [
      '     # Time       Action                                                  Duration',
      '  ──── ─────────  ─────────────────────────────────────────────────────── ────────',
      '   25. 0:03.111  Wait for selector                                          15.0s  ✗',
      '   26. 0:03.112  Wait for selector                                          15.0s  ✗',
    ].join('\n')
    expect(parseFirstFailedActionId(stdout)).toBe('25')
  })

  it('returns null when no failed action is present', () => {
    const stdout = [
      '     # Time       Action                                                  Duration',
      '  ──── ─────────  ─────────────────────────────────────────────────────── ────────',
    ].join('\n')
    expect(parseFirstFailedActionId(stdout)).toBeNull()
  })

  it('ignores rows without the ✗ marker', () => {
    const stdout = '   1. 0:00.001  Before Hooks                                               102ms'
    expect(parseFirstFailedActionId(stdout)).toBeNull()
  })

  it('handles two-line action rows (selector on continuation line)', () => {
    const stdout = [
      '   14. 1:00.276  Click getByRole(\'button\', { name: \'Sign In\' })              1.3m  ✗',
      '                 getByRole(\'button\', { name: \'Sign In\' })',
      '   15. 1:00.276  page.click                                                  1.3m  ✗',
    ].join('\n')
    expect(parseFirstFailedActionId(stdout)).toBe('14')
  })
})

// Integration test against a real trace.zip. Skipped unless CANARY_LAB_TRACE_FIXTURE
// points to one — keeps CI hermetic while letting devs validate end-to-end
// against their own canary-lab-workspace artifacts.
const FIXTURE = process.env.CANARY_LAB_TRACE_FIXTURE
const itIfFixture = FIXTURE ? it : it.skip

describe('extractTraceSummary (integration)', () => {
  let tmp: string
  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'trace-ext-')))
    execFileMock.mockReset()
  })
  afterEach(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  itIfFixture('writes a failure-summary.md with all sections from a real trace', async () => {
    const result = await extractTraceSummary({
      traceZipPath: FIXTURE!,
      outputDir: tmp,
      testName: 'fixture test',
    })
    const content = fs.readFileSync(result.summaryPath, 'utf-8')
    expect(content).toContain('# Failure summary')
    expect(content).toContain('## Failing action')
    expect(content).toContain('## Page state at failure')
    expect(content).toContain('## Failed network requests')
    expect(content).toContain('## Console errors')
    expect(content).toContain('## Action timeline')
    expect(content).toContain('## Trace metadata')
    expect(result.bytes).toBeGreaterThan(200)
  }, 60_000)

  it('throws when the trace.zip does not exist', async () => {
    await expect(
      extractTraceSummary({
        traceZipPath: path.join(tmp, 'does-not-exist.zip'),
        outputDir: tmp,
      }),
    ).rejects.toThrow(/not found/i)
  })

  it('writes a complete summary from mocked Playwright trace output', async () => {
    const traceZipPath = path.join(tmp, 'trace.zip')
    fs.writeFileSync(traceZipPath, 'zip')
    mockCliResults(
      { stdout: 'opened trace\nShell cwd was reset to /tmp/noise\n' },
      { stdout: '   2. 0:00.200  click button                                      5ms  \u2717' },
      { stdout: 'Action 2\nError: button missing' },
      { stdout: 'role=button name="Checkout"' },
      { stdout: 'GET https://example.test/api 500' },
      { stdout: 'console.error boom' },
      { stdout: ['1. goto /', ...Array.from({ length: 700 }, (_, i) => `${i + 2}. action ${i} ${'x'.repeat(40)}`)].join('\n') },
      { stdout: 'closed' },
    )

    const result = await extractTraceSummary({
      traceZipPath,
      outputDir: path.join(tmp, 'out'),
      testName: 'checkout fails',
    })

    const content = fs.readFileSync(result.summaryPath, 'utf-8')
    expect(result.failedActionId).toBe('2')
    expect(result.bytes).toBe(Buffer.byteLength(content, 'utf-8'))
    expect(content).toContain('Test: checkout fails')
    expect(content).toContain('Action 2\nError: button missing')
    expect(content).toContain('role=button name="Checkout"')
    expect(content).toContain('GET https://example.test/api 500')
    expect(content).toContain('console.error boom')
    expect(content).toContain('opened trace')
    expect(content).not.toContain('Shell cwd was reset')
    expect(content).toContain('truncated')
    expect(execFileMock).toHaveBeenCalledTimes(8)
  })

  it('renders fallback sections when trace subcommands fail or return no data', async () => {
    const traceZipPath = path.join(tmp, 'trace.zip')
    fs.writeFileSync(traceZipPath, 'zip')
    mockCliResults(
      { error: 'open failed', stdout: '' },
      { stdout: 'no failed rows' },
      { error: 'requests failed', stdout: '' },
      { stdout: '' },
      { error: 'actions failed', stdout: '' },
      { stdout: 'closed' },
    )

    const result = await extractTraceSummary({
      traceZipPath,
      outputDir: path.join(tmp, 'out'),
    })

    const content = fs.readFileSync(result.summaryPath, 'utf-8')
    expect(result.failedActionId).toBeNull()
    expect(content).toContain('No single failing action could be drilled into')
    expect(content).toContain('no failed rows')
    expect(content).toContain('no failing action identified')
    expect(content).toContain('trace requests --failed failed: requests failed')
    expect(content).toContain('## Console errors\n\n_(none)_')
    expect(content).toContain('trace actions failed: actions failed')
    expect(content).toContain('trace open failed: open failed')
    expect(execFileMock).toHaveBeenCalledTimes(6)
  })

  it('renders command errors when failing-action detail and snapshot lookup fail', async () => {
    const traceZipPath = path.join(tmp, 'trace.zip')
    fs.writeFileSync(traceZipPath, 'zip')
    mockCliResults(
      { stdout: 'opened' },
      { stdout: '   7. 0:00.700  expect visible                                   1s  \u2717' },
      { error: 'action unavailable', stdout: '' },
      { error: 'snapshot unavailable', stdout: '' },
      { stdout: '' },
      { stdout: '' },
      { stdout: '7. expect visible' },
      { stdout: 'closed' },
    )

    const result = await extractTraceSummary({
      traceZipPath,
      outputDir: path.join(tmp, 'out'),
    })

    const content = fs.readFileSync(result.summaryPath, 'utf-8')
    expect(result.failedActionId).toBe('7')
    expect(content).toContain('No single failing action could be drilled into')
    expect(content).toContain('snapshot unavailable: snapshot unavailable')
    expect(content).toContain('## Failed network requests\n\n_(none)_')
    expect(content).toContain('## Console errors\n\n_(none)_')
  })

  it('renders errors-only command failures without drilling into an action', async () => {
    const traceZipPath = path.join(tmp, 'trace.zip')
    fs.writeFileSync(traceZipPath, 'zip')
    mockCliResults(
      { stdout: 'opened' },
      { error: 'actions --errors-only failed', stdout: '' },
      { stdout: '' },
      { stdout: '' },
      { stdout: '1. goto /' },
      { stdout: 'closed' },
    )

    const result = await extractTraceSummary({
      traceZipPath,
      outputDir: path.join(tmp, 'out'),
    })

    const content = fs.readFileSync(result.summaryPath, 'utf-8')
    expect(result.failedActionId).toBeNull()
    expect(content).toContain('trace actions --errors-only failed: actions --errors-only failed')
  })

  it('truncates long single-line snapshots without needing newline boundaries', async () => {
    const traceZipPath = path.join(tmp, 'trace.zip')
    fs.writeFileSync(traceZipPath, 'zip')
    mockCliResults(
      { stdout: 'opened' },
      { stdout: '   3. 0:00.300  expect text                                      1s  \u2717' },
      { stdout: 'Action 3' },
      { stdout: 'x'.repeat(50_000) },
      { stdout: '' },
      { stdout: '' },
      { stdout: '3. expect text' },
      { stdout: 'closed' },
    )

    const result = await extractTraceSummary({
      traceZipPath,
      outputDir: path.join(tmp, 'out'),
    })

    const content = fs.readFileSync(result.summaryPath, 'utf-8')
    expect(content).toContain('truncated')
    expect(content).toContain('snapshot 3')
  })
})

type CliResult = { stdout: string; error?: never } | { error: string; stdout?: string }

function mockCliResults(...results: CliResult[]): void {
  const queue = [...results]
  execFileMock.mockImplementation(((_node, _args, _opts, callback) => {
    const next = queue.shift()
    if (!next) throw new Error('unexpected Playwright CLI invocation')
    if ('error' in next) {
      callback(new Error(next.error), next.stdout ?? '')
      return undefined
    }
    callback(null, next.stdout)
    return undefined
  }) as typeof execFile)
}
