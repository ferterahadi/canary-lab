import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFile } from 'child_process'
import {
  extractTraceSummary,
  parseFailedActionIds,
  parseFirstFailedActionId,
  stripSnapshotsCliBlock,
} from './trace-enrichment'

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

describe('parseFailedActionIds', () => {
  it('returns all failed action ordinals in order', () => {
    const stdout = [
      '   25. 0:03.111  Wait for selector                                          15.0s  ✗',
      '   26. 0:03.112  Wait for selector                                          15.0s  ✗',
      '   34. 0:05.489  Wait for selector                                          10.0s  ✗',
    ].join('\n')
    expect(parseFailedActionIds(stdout)).toEqual(['25', '26', '34'])
  })

  it('dedupes repeated ordinals', () => {
    const stdout = [
      '   25. 0:03.111  Wait for selector                                          15.0s  ✗',
      '   25. 0:03.111  Wait for selector                                          15.0s  ✗',
    ].join('\n')
    expect(parseFailedActionIds(stdout)).toEqual(['25'])
  })

  it('returns empty array when no failed rows', () => {
    expect(parseFailedActionIds('   1. ok\n')).toEqual([])
  })
})

describe('stripSnapshotsCliBlock', () => {
  it('replaces the npx playwright trace snapshot usage line with a file pointer', () => {
    const input = [
      '  Snapshots',
      '    available: before, after',
      '    usage:     npx playwright trace snapshot 25 --name <before|after>',
    ].join('\n')
    const out = stripSnapshotsCliBlock(input)
    expect(out).not.toContain('npx playwright trace')
    expect(out).toContain('available: before, after')
    expect(out).toContain('trace-extract/snapshot-at-failure.txt')
  })

  it('leaves output without the usage line unchanged', () => {
    const input = '  Snapshots\n    available: before\n'
    expect(stripSnapshotsCliBlock(input)).toBe(input)
  })
})

// Integration test against a real trace.zip. Skipped unless CANARY_LAB_TRACE_FIXTURE
// points to one — keeps CI hermetic while letting devs validate end-to-end
// against their own canary-lab-workspace artifacts.
const FIXTURE = process.env.CANARY_LAB_TRACE_FIXTURE
const itIfFixture = FIXTURE ? it : it.skip

describe('extractTraceSummary', () => {
  let tmp: string
  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'trace-ext-')))
    execFileMock.mockReset()
  })
  afterEach(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  itIfFixture('writes a self-contained trace-extract/ from a real trace', async () => {
    // Integration test runs the actual Playwright CLI; the module-level
    // child_process mock would short-circuit it. Delegate the mock to the
    // real execFile for this test only.
    const realCp = await vi.importActual<typeof import('child_process')>('child_process')
    execFileMock.mockImplementation(realCp.execFile as unknown as typeof execFile)
    const outputDir = path.join(tmp, 'out')
    const result = await extractTraceSummary({
      traceZipPath: FIXTURE!,
      outputDir,
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
    // Must not nudge the agent toward the live CLI.
    expect(content).not.toMatch(/npx playwright trace/)
    expect(content).not.toContain('Shell cwd was reset')
    // Summary stays lean (~15KB target; allow a small margin for chatty pages).
    expect(result.bytes).toBeLessThanOrEqual(16_384)
    // The CLI scratch dir is cleaned up — no stray `.playwright-cli/` in
    // the trace-extract directory.
    expect(fs.existsSync(path.join(outputDir, '.playwright-cli'))).toBe(false)
    // Drill-down files exist with non-empty content.
    for (const f of result.drillDownFiles) {
      const filePath = path.join(outputDir, f)
      expect(fs.existsSync(filePath)).toBe(true)
      expect(fs.statSync(filePath).size).toBeGreaterThan(0)
    }
  }, 90_000)

  it('throws when the trace.zip does not exist', async () => {
    await expect(
      extractTraceSummary({
        traceZipPath: path.join(tmp, 'does-not-exist.zip'),
        outputDir: tmp,
      }),
    ).rejects.toThrow(/not found/i)
  })

  it('writes a complete summary + every drill-down file from mocked output', async () => {
    const traceZipPath = path.join(tmp, 'trace.zip')
    fs.writeFileSync(traceZipPath, 'zip')
    const outputDir = path.join(tmp, 'out')

    mockByCommand({
      'trace open <zip>': () => ({ stdout: 'Browser:  chromium\nDuration: 2.1s' }),
      'trace actions': () => ({
        stdout: [
          '   # Time       Action                                                  Duration',
          '─── ─────────  ─────────────────────────────────────────────────────── ────────',
          '  1. 0:00.001  goto /                                                    180ms',
          '  2. 0:00.200  Click button                                              5ms   ✗',
        ].join('\n'),
      }),
      'trace actions --errors-only': () => ({
        stdout: [
          '   # Time       Action                                                  Duration',
          '─── ─────────  ─────────────────────────────────────────────────────── ────────',
          '  2. 0:00.200  Click button                                              5ms   ✗',
        ].join('\n'),
      }),
      'trace action 2': () => ({
        stdout: [
          '  Click button',
          '  Error',
          '    TimeoutError: button missing',
          '  Snapshots',
          '    available: before, after',
          '    usage:     npx playwright trace snapshot 2 --name <before|after>',
        ].join('\n'),
      }),
      'trace snapshot 2': () => ({ stdout: '- button "Checkout" [ref=e1]' }),
      'trace snapshot 2 --name before': () => ({ stdout: '- button "Checkout" [ref=e1] before' }),
      'trace requests --failed': () => ({ stdout: 'GET https://example.test/api 500' }),
      'trace console --errors-only': () => ({ stdout: 'console.error boom' }),
      'trace close': () => ({ stdout: 'closed' }),
    })

    const result = await extractTraceSummary({
      traceZipPath,
      outputDir,
      testName: 'checkout fails',
    })

    expect(result.failedActionId).toBe('2')
    expect(result.bytes).toBe(Buffer.byteLength(fs.readFileSync(result.summaryPath, 'utf-8'), 'utf-8'))

    const content = fs.readFileSync(result.summaryPath, 'utf-8')
    // Headline content lands in the summary.
    expect(content).toContain('Test: checkout fails')
    expect(content).toContain('TimeoutError: button missing')
    expect(content).toContain('- button "Checkout" [ref=e1]')
    expect(content).toContain('GET https://example.test/api 500')
    expect(content).toContain('console.error boom')
    expect(content).toContain('Browser:  chromium')
    // The CLI suggestion lines are rewritten to file pointers.
    expect(content).not.toMatch(/npx playwright trace/)
    expect(content).toContain('trace-extract/snapshot-at-failure.txt')

    // Every drill-down file is on disk with the full CLI output.
    expect(result.drillDownFiles).toContain('metadata.txt')
    expect(result.drillDownFiles).toContain('actions.txt')
    expect(result.drillDownFiles).toContain('failing-action.txt')
    expect(result.drillDownFiles).toContain('failed-actions.txt')
    expect(result.drillDownFiles).toContain('snapshot-at-failure.txt')
    expect(result.drillDownFiles).toContain('snapshot-before.txt')
    expect(result.drillDownFiles).toContain('network-failed.txt')
    expect(result.drillDownFiles).toContain('console-errors.txt')

    // Drill-down files carry the FULL CLI output (no truncation).
    expect(fs.readFileSync(path.join(outputDir, 'failing-action.txt'), 'utf-8'))
      .toContain('Error\n    TimeoutError: button missing')
    expect(fs.readFileSync(path.join(outputDir, 'snapshot-at-failure.txt'), 'utf-8'))
      .toBe('- button "Checkout" [ref=e1]')
    expect(fs.readFileSync(path.join(outputDir, 'snapshot-before.txt'), 'utf-8'))
      .toBe('- button "Checkout" [ref=e1] before')
    expect(fs.readFileSync(path.join(outputDir, 'network-failed.txt'), 'utf-8'))
      .toBe('GET https://example.test/api 500')
    expect(fs.readFileSync(path.join(outputDir, 'console-errors.txt'), 'utf-8'))
      .toBe('console.error boom')
  })

  it('writes failed-actions.txt with every ✗ action concatenated when there are multiple', async () => {
    const traceZipPath = path.join(tmp, 'trace.zip')
    fs.writeFileSync(traceZipPath, 'zip')
    const outputDir = path.join(tmp, 'out')

    mockByCommand({
      'trace open <zip>': () => ({ stdout: 'meta' }),
      'trace actions': () => ({
        stdout: [
          '   # Time       Action       Duration',
          '─── ─────────  ───────────── ────────',
          ' 25. t  wait for selector  15s  ✗',
          ' 26. t  wait for selector  15s  ✗',
          ' 27. t  wait for selector  15s  ✗',
        ].join('\n'),
      }),
      'trace actions --errors-only': () => ({
        stdout: [
          '   # Time       Action       Duration',
          '─── ─────────  ───────────── ────────',
          ' 25. t  wait for selector  15s  ✗',
          ' 26. t  wait for selector  15s  ✗',
          ' 27. t  wait for selector  15s  ✗',
        ].join('\n'),
      }),
      'trace action 25': () => ({ stdout: 'Action 25 detail' }),
      'trace action 26': () => ({ stdout: 'Action 26 detail' }),
      'trace action 27': () => ({ stdout: 'Action 27 detail' }),
      'trace snapshot 25': () => ({ stdout: 'snap25' }),
      'trace snapshot 25 --name before': () => ({ stdout: 'snap25-before' }),
      'trace requests --failed': () => ({ stdout: '' }),
      'trace console --errors-only': () => ({ stdout: '' }),
      'trace close': () => ({ stdout: 'closed' }),
    })

    const result = await extractTraceSummary({
      traceZipPath,
      outputDir,
    })

    expect(result.failedActionId).toBe('25')
    const failedActions = fs.readFileSync(path.join(outputDir, 'failed-actions.txt'), 'utf-8')
    expect(failedActions).toContain('# Action 25')
    expect(failedActions).toContain('Action 25 detail')
    expect(failedActions).toContain('# Action 26')
    expect(failedActions).toContain('Action 26 detail')
    expect(failedActions).toContain('# Action 27')
    expect(failedActions).toContain('Action 27 detail')

    const summary = fs.readFileSync(result.summaryPath, 'utf-8')
    expect(summary).toContain('There are 3 failed actions in this trace')
    expect(summary).toContain('trace-extract/failed-actions.txt')
  })

  it('truncates the snapshot section in the summary and points at the full file', async () => {
    const traceZipPath = path.join(tmp, 'trace.zip')
    fs.writeFileSync(traceZipPath, 'zip')
    const outputDir = path.join(tmp, 'out')
    // 300-line snapshot — the summary should slice to 150 lines and point
    // the agent at the full sibling file.
    const snapshotBody = Array.from({ length: 300 }, (_, i) => `line ${i + 1}`).join('\n')

    mockByCommand({
      'trace open <zip>': () => ({ stdout: 'meta' }),
      'trace actions': () => ({ stdout: 'h1\nh2\n 3. t click 1s  ✗' }),
      'trace actions --errors-only': () => ({ stdout: 'h1\nh2\n 3. t click 1s  ✗' }),
      'trace action 3': () => ({ stdout: 'action 3 detail' }),
      'trace snapshot 3': () => ({ stdout: snapshotBody }),
      'trace snapshot 3 --name before': () => ({ stdout: '' }),
      'trace requests --failed': () => ({ stdout: '' }),
      'trace console --errors-only': () => ({ stdout: '' }),
      'trace close': () => ({ stdout: '' }),
    })

    const result = await extractTraceSummary({ traceZipPath, outputDir })
    const summary = fs.readFileSync(result.summaryPath, 'utf-8')
    expect(summary).toContain('line 1')
    expect(summary).toContain('line 150')
    expect(summary).not.toContain('line 151')
    expect(summary).toContain('… (truncated)')
    expect(summary).toContain('Full tree: trace-extract/snapshot-at-failure.txt')

    // Drill-down file carries all 300 lines.
    const fullSnap = fs.readFileSync(path.join(outputDir, 'snapshot-at-failure.txt'), 'utf-8')
    expect(fullSnap).toContain('line 300')
  })

  it('renders fallback sections when subcommands fail or return empty data', async () => {
    const traceZipPath = path.join(tmp, 'trace.zip')
    fs.writeFileSync(traceZipPath, 'zip')
    const outputDir = path.join(tmp, 'out')

    mockByCommand({
      'trace open <zip>': () => ({ error: 'open failed' }),
      'trace actions': () => ({ error: 'actions failed' }),
      'trace actions --errors-only': () => ({ stdout: '' }),
      'trace requests --failed': () => ({ error: 'requests failed' }),
      'trace console --errors-only': () => ({ stdout: '' }),
      'trace close': () => ({ stdout: '' }),
    })

    const result = await extractTraceSummary({
      traceZipPath,
      outputDir,
    })

    const content = fs.readFileSync(result.summaryPath, 'utf-8')
    expect(result.failedActionId).toBeNull()
    expect(content).toContain('_(no failing actions identified')
    expect(content).toContain('trace requests --failed failed: requests failed')
    expect(content).toContain('## Console errors\n\n_(none)_')
    expect(content).toContain('trace actions failed: actions failed')
    expect(content).toContain('trace open failed: open failed')
  })

  it('renders failure messages when errorsOnly and consoleErrors subcommands fail', async () => {
    const traceZipPath = path.join(tmp, 'trace.zip')
    fs.writeFileSync(traceZipPath, 'zip')
    const outputDir = path.join(tmp, 'out')

    mockByCommand({
      'trace open <zip>': () => ({ stdout: 'opened' }),
      'trace actions': () => ({ stdout: '' }),
      'trace actions --errors-only': () => ({ error: 'errors-only failed' }),
      'trace requests --failed': () => ({ stdout: '' }),
      'trace console --errors-only': () => ({ error: 'console failed' }),
      'trace close': () => ({ stdout: '' }),
    })

    const result = await extractTraceSummary({ traceZipPath, outputDir })
    const content = fs.readFileSync(result.summaryPath, 'utf-8')
    expect(result.failedActionId).toBeNull()
    expect(content).toContain('trace actions --errors-only failed: errors-only failed')
    expect(content).toContain('trace console --errors-only failed: console failed')
  })

  it('renders "Full list" pointers when failed requests, console errors, or actions exceed caps', async () => {
    const traceZipPath = path.join(tmp, 'trace.zip')
    fs.writeFileSync(traceZipPath, 'zip')
    const outputDir = path.join(tmp, 'out')
    const failingActionLine = ' 99. 0:00.001  click button                                      1ms  ✗'
    // 20 action rows triggers >15 cap; 15 request rows triggers >10 cap.
    const actionRows = Array.from({ length: 20 }, (_, i) => ` ${i + 1}. 0:00.001  step ${i + 1}                                  1ms`)
    const requestRows = Array.from({ length: 15 }, (_, i) => `GET https://example.test/req${i} 500`)
    const consoleRows = Array.from({ length: 15 }, (_, i) => `console.error err-${i}`)

    mockByCommand({
      'trace open <zip>': () => ({ stdout: 'meta' }),
      'trace actions': () => ({
        stdout: ['h1', 'h2', ...actionRows, failingActionLine].join('\n'),
      }),
      'trace actions --errors-only': () => ({ stdout: ['h1', 'h2', failingActionLine].join('\n') }),
      'trace action 99': () => ({ stdout: 'detail' }),
      'trace snapshot 99': () => ({ stdout: 'snap' }),
      'trace snapshot 99 --name before': () => ({ stdout: '' }),
      'trace requests --failed': () => ({ stdout: ['h1', 'h2', ...requestRows].join('\n') }),
      'trace console --errors-only': () => ({ stdout: ['h1', 'h2', ...consoleRows].join('\n') }),
      'trace close': () => ({ stdout: '' }),
    })

    const result = await extractTraceSummary({ traceZipPath, outputDir })
    const content = fs.readFileSync(result.summaryPath, 'utf-8')
    expect(content).toContain('Full list (15 failed requests): trace-extract/network-failed.txt')
    expect(content).toContain('Full list (15 console errors): trace-extract/console-errors.txt')
    expect(content).toContain('Full timeline (21 actions): trace-extract/actions.txt')
  })

  it('still produces a usable summary when first-failure detail and snapshot fail', async () => {
    const traceZipPath = path.join(tmp, 'trace.zip')
    fs.writeFileSync(traceZipPath, 'zip')
    const outputDir = path.join(tmp, 'out')

    mockByCommand({
      'trace open <zip>': () => ({ stdout: 'opened' }),
      'trace actions': () => ({ stdout: 'h1\nh2\n 7. t  expect visible  1s  ✗' }),
      'trace actions --errors-only': () => ({ stdout: 'h1\nh2\n 7. t  expect visible  1s  ✗' }),
      'trace action 7': () => ({ error: 'action unavailable' }),
      'trace snapshot 7': () => ({ error: 'snapshot unavailable' }),
      'trace snapshot 7 --name before': () => ({ error: 'before unavailable' }),
      'trace requests --failed': () => ({ stdout: '' }),
      'trace console --errors-only': () => ({ stdout: '' }),
      'trace close': () => ({ stdout: '' }),
    })

    const result = await extractTraceSummary({
      traceZipPath,
      outputDir,
    })

    const content = fs.readFileSync(result.summaryPath, 'utf-8')
    expect(result.failedActionId).toBe('7')
    expect(content).toContain('No single failing action could be drilled into')
    expect(content).toContain('snapshot unavailable: snapshot unavailable')
    expect(content).toContain('## Failed network requests\n\n_(none)_')
    expect(content).toContain('## Console errors\n\n_(none)_')
  })
})

// ─── Test helpers ───────────────────────────────────────────────────────────

type CliResult = { stdout: string; error?: never } | { error: string; stdout?: string }

/**
 * Dispatch mock by Playwright CLI command (e.g. "trace actions --errors-only").
 * The `<zip>` placeholder matches any trace.zip path so tests don't have to
 * spell out tmp paths. Throws on an unhandled command — surface gaps in test
 * coverage instead of silently returning empty output.
 */
function mockByCommand(handlers: Record<string, () => CliResult>): void {
  execFileMock.mockImplementation(((_node, args, _opts, callback) => {
    const argList = (args as readonly string[]) ?? []
    // Drop the leading cli.js path; keep the playwright subcommand + flags.
    const cmd = argList.slice(1).map((a) => (a.endsWith('.zip') ? '<zip>' : a)).join(' ')
    const handler = handlers[cmd]
    if (!handler) throw new Error(`unhandled Playwright CLI command in test: \`${cmd}\``)
    const r = handler()
    if ('error' in r) callback(new Error(r.error), r.stdout ?? '', '')
    else callback(null, r.stdout, '')
    return undefined
  }) as typeof execFile)
}
