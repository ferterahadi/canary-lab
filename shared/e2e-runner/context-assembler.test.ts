import { describe, it, expect, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-context-')))
const LOGS_DIR = path.join(tmpRoot, 'logs')
const BENCHMARK_DIR = path.join(LOGS_DIR, 'benchmark')
const SUMMARY_PATH = path.join(LOGS_DIR, 'e2e-summary.json')
const DIAGNOSIS_JOURNAL_PATH = path.join(LOGS_DIR, 'diagnosis-journal.json')
const MANIFEST_PATH = path.join(LOGS_DIR, 'manifest.json')

fs.mkdirSync(LOGS_DIR, { recursive: true })

vi.mock('./paths', () => ({
  ROOT: tmpRoot,
  LOGS_DIR,
  BENCHMARK_DIR,
  SUMMARY_PATH,
  DIAGNOSIS_JOURNAL_PATH,
  MANIFEST_PATH,
}))

const { buildBenchmarkContextSnapshot } = await import('./context-assembler')

afterEach(() => {
  fs.rmSync(LOGS_DIR, { recursive: true, force: true })
  fs.mkdirSync(LOGS_DIR, { recursive: true })
})

describe('buildBenchmarkContextSnapshot', () => {
  it('builds canary context with enriched logs and diagnosis journal metrics', () => {
    fs.writeFileSync(
      SUMMARY_PATH,
      JSON.stringify({
        total: 1,
        passed: 0,
        failed: [
          {
            name: 'checkout',
            logs: {
              'svc-api': 'api failed',
              'svc-web': 'web failed',
            },
          },
        ],
      }),
    )
    fs.writeFileSync(DIAGNOSIS_JOURNAL_PATH, JSON.stringify([{ hypothesis: 'x' }]))
    const rawLog = path.join(LOGS_DIR, 'svc-api.log')
    fs.writeFileSync(rawLog, 'raw log body')
    fs.writeFileSync(MANIFEST_PATH, JSON.stringify({ serviceLogs: [rawLog] }))

    const snapshot = buildBenchmarkContextSnapshot('run-1', 1, 'canary')

    expect(snapshot.mode).toBe('canary')
    expect(snapshot.summaryPath).toBe(SUMMARY_PATH)
    expect(snapshot.journalPath).toBe(DIAGNOSIS_JOURNAL_PATH)
    expect(snapshot.includedFailedTests).toEqual(['checkout'])
    expect(snapshot.includedLogFiles).toContain('logs/svc-api.log')
    expect(snapshot.includedLogSlices['svc-api']).toBeGreaterThan(0)
    expect(snapshot.journalBytes).toBeGreaterThan(0)
    expect(snapshot.rawServiceLogBytesAvailable).toBeGreaterThan(0)
    expect(snapshot.promptAddendum).toContain('canary benchmark run')
  })

  it('builds baseline context with a Playwright-only summary artifact and excluded artifacts list', () => {
    fs.writeFileSync(
      SUMMARY_PATH,
      JSON.stringify({
        total: 1,
        passed: 0,
        failed: [
          {
            name: 'checkout',
            error: { message: 'expected 200' },
            logs: { 'svc-api': 'should not be included' },
          },
        ],
      }),
    )

    const snapshot = buildBenchmarkContextSnapshot('run-2', 2, 'baseline')

    expect(snapshot.mode).toBe('baseline')
    expect(snapshot.summaryPath).toBe(path.join(BENCHMARK_DIR, 'context', 'cycle-2-summary.json'))
    expect(fs.existsSync(snapshot.summaryPath)).toBe(true)
    expect(snapshot.journalPath).toBeNull()
    expect(snapshot.includedLogFiles).toEqual([])
    expect(snapshot.slicedLogBytes).toBe(0)
    expect(snapshot.journalBytes).toBe(0)
    expect(snapshot.excludedArtifacts).toContain('failed[].logs')
    const stripped = JSON.parse(fs.readFileSync(snapshot.summaryPath, 'utf-8'))
    expect(stripped.failed[0].logs).toBeUndefined()
    expect(snapshot.promptAddendum).toContain('Use only logs/benchmark/context/cycle-2-summary.json')
    expect(snapshot.promptAddendum).toContain('Playwright failure context only')
  })
})
