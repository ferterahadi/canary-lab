import { describe, it, expect, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-bench-')))
const LOGS_DIR = path.join(tmpRoot, 'logs')
const BENCHMARK_DIR = path.join(LOGS_DIR, 'benchmark')

fs.mkdirSync(LOGS_DIR, { recursive: true })

vi.mock('./paths', () => ({
  ROOT: tmpRoot,
  LOGS_DIR,
  BENCHMARK_DIR,
}))

const {
  createBenchmarkTracker,
  startBenchmarkCycle,
  noteBenchmarkSignal,
  finalizeBenchmarkCycle,
  finalizeBenchmarkRun,
  benchmarkUsagePath,
} = await import('./benchmark')

afterEach(() => {
  fs.rmSync(BENCHMARK_DIR, { recursive: true, force: true })
})

describe('benchmark tracker', () => {
  it('writes run metadata and appends finalized cycle records', () => {
    const tracker = createBenchmarkTracker({
      runId: 'run-1',
      feature: 'checkout',
      benchmarkMode: 'canary',
      startedAt: '2026-04-21T00:00:00.000Z',
      modelProvider: 'codex',
      maxCycles: 3,
      headed: false,
      autoHealEnabled: true,
      healSession: 'resume',
    })

    expect(fs.existsSync(path.join(BENCHMARK_DIR, 'run.json'))).toBe(true)

    const usagePath = startBenchmarkCycle(tracker, 1, 'checkout failed', {
      runId: 'run-1',
      cycle: 1,
      mode: 'canary',
      summaryPath: path.join(LOGS_DIR, 'e2e-summary.json'),
      journalPath: path.join(LOGS_DIR, 'diagnosis-journal.md'),
      includedLogFiles: ['logs/svc-api.log'],
      includedFailedTests: ['checkout'],
      summaryBytes: 100,
      journalBytes: 20,
      includedLogSlices: { 'svc-api': 50 },
      excludedArtifacts: [],
      filesIncluded: 3,
      contextBytes: 170,
      contextChars: 170,
      slicedLogBytes: 50,
      rawServiceLogBytesAvailable: 400,
      notes: 'note',
      promptAddendum: 'read the summary',
    })

    fs.writeFileSync(
      usagePath,
      JSON.stringify({ inputTokens: 12, outputTokens: 5 }) + '\n',
    )
    noteBenchmarkSignal(tracker, '.rerun')
    const record = finalizeBenchmarkCycle(tracker, 'completed', true)

    expect(record?.signalWritten).toBe('.rerun')
    expect(record?.inputTokens).toBe(12)
    expect(record?.outputTokens).toBe(5)
    expect(record?.totalTokens).toBe(17)

    const cycleLines = fs.readFileSync(path.join(BENCHMARK_DIR, 'cycles.jsonl'), 'utf-8')
      .trim()
      .split('\n')
    expect(cycleLines).toHaveLength(1)
  })

  it('writes a final summary and omits token totals when no usage was captured', () => {
    const tracker = createBenchmarkTracker({
      runId: 'run-2',
      feature: 'checkout',
      benchmarkMode: 'baseline',
      startedAt: '2026-04-21T00:00:00.000Z',
      modelProvider: null,
      maxCycles: 3,
      headed: false,
      autoHealEnabled: false,
      healSession: 'new',
    })

    startBenchmarkCycle(tracker, 1, 'checkout failed', {
      runId: 'run-2',
      cycle: 1,
      mode: 'baseline',
      summaryPath: path.join(BENCHMARK_DIR, 'context', 'cycle-1-summary.json'),
      journalPath: null,
      includedLogFiles: [],
      includedFailedTests: ['checkout'],
      summaryBytes: 80,
      journalBytes: 0,
      includedLogSlices: {},
      excludedArtifacts: ['failed[].logs'],
      filesIncluded: 1,
      contextBytes: 80,
      contextChars: 80,
      slicedLogBytes: 0,
      rawServiceLogBytesAvailable: 500,
      notes: 'baseline',
      promptAddendum: 'use only the Playwright failure summary',
    })

    expect(benchmarkUsagePath(1)).toContain('cycle-1.jsonl')
    finalizeBenchmarkCycle(tracker, 'agent_exited_no_signal', false)
    finalizeBenchmarkRun(tracker, 'agent_exited_no_signal', false)

    const summary = JSON.parse(
      fs.readFileSync(path.join(BENCHMARK_DIR, 'final-summary.json'), 'utf-8'),
    )
    expect(summary.finalStatus).toBe('agent_exited_no_signal')
    expect(summary.totalInputTokens).toBeUndefined()
    expect(summary.totalContextBytes).toBe(80)
  })
})
