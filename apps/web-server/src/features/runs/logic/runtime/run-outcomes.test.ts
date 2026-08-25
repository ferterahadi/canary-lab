import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { readLatestRunOutcomes, lastRunOutcomeForTitle } from './run-outcomes'

let logsDir: string

beforeEach(() => {
  logsDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-ro-')))
})

afterEach(() => {
  fs.rmSync(logsDir, { recursive: true, force: true })
})

function seedIndex(entries: Array<{ runId: string; feature: string; startedAt: string; executionType?: string }>): void {
  fs.mkdirSync(path.join(logsDir, 'runs'), { recursive: true })
  fs.writeFileSync(
    path.join(logsDir, 'runs', 'index.json'),
    JSON.stringify(entries.map((e) => ({ status: 'failed', ...e }))),
  )
}

function seedSummary(runId: string, summary: unknown): void {
  const dir = path.join(logsDir, 'runs', runId)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'e2e-summary.json'), JSON.stringify(summary))
}

describe('readLatestRunOutcomes', () => {
  it('returns null when the feature has no recorded runs', () => {
    seedIndex([{ runId: 'r1', feature: 'other', startedAt: '2026-01-01T00:00:00Z' }])
    expect(readLatestRunOutcomes(logsDir, 'demo')).toBeNull()
  })

  it('reads the newest run of the feature by startedAt', () => {
    seedIndex([
      { runId: 'r-old', feature: 'demo', startedAt: '2026-01-01T00:00:00Z' },
      { runId: 'r-new', feature: 'demo', startedAt: '2026-01-02T00:00:00Z' },
    ])
    seedSummary('r-old', { passedNames: ['test-case-a'], failed: [] })
    seedSummary('r-new', { passedNames: [], failed: [{ name: 'test-case-a' }] })
    const outcomes = readLatestRunOutcomes(logsDir, 'demo')
    expect(outcomes?.runId).toBe('r-new')
    expect(outcomes?.failed.has('test-case-a')).toBe(true)
  })

  it('falls back to an older run when the newest has no readable summary', () => {
    seedIndex([
      { runId: 'r-old', feature: 'demo', startedAt: '2026-01-01T00:00:00Z' },
      { runId: 'r-new', feature: 'demo', startedAt: '2026-01-02T00:00:00Z' },
    ])
    seedSummary('r-old', { passedNames: ['test-case-a'], failed: [] })
    const outcomes = readLatestRunOutcomes(logsDir, 'demo')
    expect(outcomes?.runId).toBe('r-old')
    expect(outcomes?.passed.has('test-case-a')).toBe(true)
  })

  it('sorts three runs newest-first regardless of input order', () => {
    // A three-entry index forces the sort comparator to exercise both the
    // "a is older than b" and "a is newer than/equal to b" comparisons,
    // rather than relying on a single pairwise call.
    seedIndex([
      { runId: 'r-mid', feature: 'demo', startedAt: '2026-01-02T00:00:00Z' },
      { runId: 'r-oldest', feature: 'demo', startedAt: '2026-01-01T00:00:00Z' },
      { runId: 'r-newest', feature: 'demo', startedAt: '2026-01-03T00:00:00Z' },
    ])
    seedSummary('r-newest', { passedNames: ['test-case-a'], failed: [] })
    const outcomes = readLatestRunOutcomes(logsDir, 'demo')
    expect(outcomes?.runId).toBe('r-newest')
  })

  it('treats a non-array passedNames/failed/passedOnRetry as empty rather than throwing', () => {
    seedIndex([{ runId: 'r1', feature: 'demo', startedAt: '2026-01-01T00:00:00Z' }])
    seedSummary('r1', { passedNames: 'not-an-array', failed: 'also-not-an-array', passedOnRetry: 42 })
    const outcomes = readLatestRunOutcomes(logsDir, 'demo')
    expect(outcomes?.passed.size).toBe(0)
    expect(outcomes?.failed.size).toBe(0)
    expect(outcomes?.passedOnRetry.size).toBe(0)
    expect(outcomes?.spansExecutions).toBe(false)
  })

  it('skips boot and benchmark entries — the join wants suite evidence, and a verify run still counts', () => {
    // Newest entry is a benchmark arm, next a boot session: both have readable
    // summaries (the worst case — a benchmark writes a real one), yet neither
    // may feed the proven axis. The verify run behind them is genuine evidence
    // and must win.
    seedIndex([
      { runId: 'r-bench', feature: 'demo', startedAt: '2026-01-04T00:00:00Z', executionType: 'benchmark' },
      { runId: 'r-boot', feature: 'demo', startedAt: '2026-01-03T00:00:00Z', executionType: 'boot' },
      { runId: 'r-verify', feature: 'demo', startedAt: '2026-01-02T00:00:00Z', executionType: 'verify' },
    ])
    seedSummary('r-bench', { passedNames: ['test-case-a'], failed: [] })
    seedSummary('r-boot', { passedNames: ['test-case-a'], failed: [] })
    seedSummary('r-verify', { passedNames: ['test-case-a'], failed: [] })
    const outcomes = readLatestRunOutcomes(logsDir, 'demo')
    expect(outcomes?.runId).toBe('r-verify')
  })

  it('carries passedOnRetry names and the merged-execution flag off the summary', () => {
    seedIndex([{ runId: 'r1', feature: 'demo', startedAt: '2026-01-01T00:00:00Z' }])
    seedSummary('r1', {
      passedNames: ['test-case-a', 'test-case-b'],
      failed: [],
      passedOnRetry: ['test-case-b', '', 42],
      mergedFromPriorExecution: true,
    })
    const outcomes = readLatestRunOutcomes(logsDir, 'demo')
    expect(outcomes?.passedOnRetry).toEqual(new Set(['test-case-b']))
    expect(outcomes?.spansExecutions).toBe(true)
  })

  it('ignores malformed failed entries (non-object, or object without a string name)', () => {
    seedIndex([{ runId: 'r1', feature: 'demo', startedAt: '2026-01-01T00:00:00Z' }])
    seedSummary('r1', {
      passedNames: [],
      failed: [null, 'a-string-not-an-object', { name: 42 }, {}, { name: 'test-case-real' }],
    })
    const outcomes = readLatestRunOutcomes(logsDir, 'demo')
    expect(outcomes?.failed.size).toBe(1)
    expect(outcomes?.failed.has('test-case-real')).toBe(true)
  })
})

describe('lastRunOutcomeForTitle', () => {
  it('joins a spec test title to the summary slug convention', () => {
    const outcomes = {
      runId: 'r1',
      passed: new Set(['test-case-user-can-log-in']),
      failed: new Set(['test-case-checkout-declines-invalid-card']),
      passedOnRetry: new Set<string>(),
      spansExecutions: false,
    }
    expect(lastRunOutcomeForTitle(outcomes, 'User can log in!'))
      .toEqual({ runId: 'r1', passed: true })
    expect(lastRunOutcomeForTitle(outcomes, 'Checkout declines invalid card'))
      .toEqual({ runId: 'r1', passed: false })
    expect(lastRunOutcomeForTitle(outcomes, 'Brand new test')).toBeUndefined()
  })

  it('marks a pass that needed a retry, and never marks a clean one', () => {
    const outcomes = {
      runId: 'r1',
      passed: new Set(['test-case-flaky-pass', 'test-case-clean-pass']),
      failed: new Set<string>(),
      passedOnRetry: new Set(['test-case-flaky-pass']),
      spansExecutions: false,
    }
    expect(lastRunOutcomeForTitle(outcomes, 'Flaky pass'))
      .toEqual({ runId: 'r1', passed: true, retried: true })
    expect(lastRunOutcomeForTitle(outcomes, 'Clean pass'))
      .toEqual({ runId: 'r1', passed: true })
  })
})
