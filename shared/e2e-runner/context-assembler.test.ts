import { describe, it, expect, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-context-')))
const LOGS_DIR = path.join(tmpRoot, 'logs')
const BENCHMARK_DIR = path.join(LOGS_DIR, 'benchmark')
const SUMMARY_PATH = path.join(LOGS_DIR, 'e2e-summary.json')
const DIAGNOSIS_JOURNAL_PATH = path.join(LOGS_DIR, 'diagnosis-journal.md')
const MANIFEST_PATH = path.join(LOGS_DIR, 'manifest.json')
const PLAYWRIGHT_STDOUT_PATH = path.join(LOGS_DIR, 'playwright-stdout.log')
const HEAL_INDEX_PATH = path.join(LOGS_DIR, 'heal-index.md')
const FAILED_DIR = path.join(LOGS_DIR, 'failed')

fs.mkdirSync(LOGS_DIR, { recursive: true })

vi.mock('./paths', () => ({
  ROOT: tmpRoot,
  LOGS_DIR,
  BENCHMARK_DIR,
  SUMMARY_PATH,
  DIAGNOSIS_JOURNAL_PATH,
  MANIFEST_PATH,
  PLAYWRIGHT_STDOUT_PATH,
  HEAL_INDEX_PATH,
  FAILED_DIR,
}))

const { buildBenchmarkContextSnapshot } = await import('./context-assembler')

afterEach(() => {
  fs.rmSync(LOGS_DIR, { recursive: true, force: true })
  fs.mkdirSync(LOGS_DIR, { recursive: true })
})

describe('buildBenchmarkContextSnapshot', () => {
  it('builds canary context pointing at heal-index.md with per-failure slice paths', () => {
    // Post-enrichment summary: no embedded logs[], just logFiles paths.
    fs.writeFileSync(
      SUMMARY_PATH,
      JSON.stringify({
        total: 1,
        passed: 0,
        failed: [
          {
            name: 'checkout',
            logFiles: [
              'logs/failed/checkout/svc-api.log',
              'logs/failed/checkout/svc-web.log',
            ],
          },
        ],
      }),
    )
    fs.writeFileSync(HEAL_INDEX_PATH, '# Heal Index\n\n1 test failed.\n')
    fs.writeFileSync(DIAGNOSIS_JOURNAL_PATH, JSON.stringify([{ hypothesis: 'x' }]))

    // Per-failure slice files + raw service log + manifest.
    const checkoutDir = path.join(FAILED_DIR, 'checkout')
    fs.mkdirSync(checkoutDir, { recursive: true })
    fs.writeFileSync(path.join(checkoutDir, 'svc-api.log'), 'api slice')
    fs.writeFileSync(path.join(checkoutDir, 'svc-web.log'), 'web slice bigger')
    const rawLog = path.join(LOGS_DIR, 'svc-api.log')
    fs.writeFileSync(rawLog, 'raw log body')
    fs.writeFileSync(MANIFEST_PATH, JSON.stringify({ serviceLogs: [rawLog] }))

    const snapshot = buildBenchmarkContextSnapshot('run-1', 1, 'canary')

    expect(snapshot.mode).toBe('canary')
    expect(snapshot.summaryPath).toBe(HEAL_INDEX_PATH)
    expect(snapshot.journalPath).toBe(DIAGNOSIS_JOURNAL_PATH)
    expect(snapshot.includedFailedTests).toEqual(['checkout'])
    expect(snapshot.includedLogFiles).toEqual([
      'logs/failed/checkout/svc-api.log',
      'logs/failed/checkout/svc-web.log',
    ])
    expect(snapshot.includedLogSlices['svc-api']).toBe(9) // 'api slice'
    expect(snapshot.includedLogSlices['svc-web']).toBe(16) // 'web slice bigger'
    expect(snapshot.summaryBytes).toBeGreaterThan(0) // index bytes
    expect(snapshot.journalBytes).toBeGreaterThan(0)
    expect(snapshot.rawServiceLogBytesAvailable).toBeGreaterThan(0)
    expect(snapshot.promptAddendum).toContain('Benchmark telemetry is on')
    expect(snapshot.promptAddendum).toContain('logs/heal-index.md')
    expect(snapshot.promptAddendum).toContain('logs/failed/<slug>/<svc>.log')
  })

  it('builds baseline context pointing at raw Playwright stdout, ignoring enriched summary and journal', () => {
    // Baseline must not read or depend on canary-lab artifacts — even if they
    // exist on disk, the snapshot should ignore them and point only at
    // playwright-stdout.log.
    fs.writeFileSync(
      SUMMARY_PATH,
      JSON.stringify({
        total: 1,
        passed: 0,
        failed: [{ name: 'checkout', logs: { 'svc-api': 'leaked' } }],
      }),
    )
    fs.writeFileSync(DIAGNOSIS_JOURNAL_PATH, JSON.stringify([{ hypothesis: 'x' }]))
    fs.writeFileSync(PLAYWRIGHT_STDOUT_PATH, 'raw playwright output line 1\nline 2\n')

    const snapshot = buildBenchmarkContextSnapshot('run-2', 2, 'baseline')

    expect(snapshot.mode).toBe('baseline')
    expect(snapshot.summaryPath).toBe(PLAYWRIGHT_STDOUT_PATH)
    expect(snapshot.journalPath).toBeNull()
    expect(snapshot.includedLogFiles).toEqual([])
    expect(snapshot.slicedLogBytes).toBe(0)
    expect(snapshot.journalBytes).toBe(0)
    expect(snapshot.rawServiceLogBytesAvailable).toBe(0)
    expect(snapshot.summaryBytes).toBeGreaterThan(0)
    expect(snapshot.contextBytes).toBe(snapshot.summaryBytes)
    expect(snapshot.excludedArtifacts).toEqual(
      expect.arrayContaining([
        'logs/e2e-summary.json',
        'logs/diagnosis-journal.md',
        'logs/svc-*.log',
        'failed[].logs',
        '.claude/skills/heal-loop.md',
      ]),
    )
    expect(snapshot.promptAddendum).toBe('')
    expect(snapshot.notes).toContain('raw Playwright stdout only')
    // No canary-lab-crafted summary file is written in the benchmark context dir.
    expect(fs.existsSync(path.join(BENCHMARK_DIR, 'context', 'cycle-2-summary.json'))).toBe(false)
  })

  it('reports zero summary bytes when playwright-stdout.log is absent', () => {
    const snapshot = buildBenchmarkContextSnapshot('run-3', 1, 'baseline')
    expect(snapshot.summaryBytes).toBe(0)
    expect(snapshot.filesIncluded).toBe(0)
    expect(snapshot.contextBytes).toBe(0)
  })
})
