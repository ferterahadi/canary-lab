import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { extractTraceSummary, parseFirstFailedActionId } from './trace-enrichment'

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
})
