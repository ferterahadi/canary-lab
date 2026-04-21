import fs from 'fs'
import path from 'path'
import { BENCHMARK_DIR, ROOT } from './paths'
import type { BenchmarkContextSnapshot, BenchmarkMode } from './context-assembler'

export interface BenchmarkRunInfo {
  runId: string
  feature: string
  benchmarkMode: BenchmarkMode
  startedAt: string
  modelProvider: string | null
  maxCycles: number
  headed: boolean
  autoHealEnabled: boolean
  projectRoot: string
  healSession: 'resume' | 'new'
}

export interface BenchmarkCycleRecord {
  runId: string
  cycle: number
  phase: 'auto-heal'
  startedAt: string
  endedAt: string
  durationMs: number
  failureSignature: string
  signalWritten: '.rerun' | '.restart' | null
  greenAfterCycle: boolean
  summaryBytes: number
  slicedLogBytes: number
  journalBytes: number
  rawServiceLogBytesAvailable: number
  filesIncluded: number
  contextBytes: number
  contextChars: number
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  success: boolean
  status: 'completed' | 'agent_exited_no_signal' | 'timeout' | 'max_cycles_reached'
}

export interface BenchmarkFinalSummary {
  runId: string
  feature: string
  benchmarkMode: BenchmarkMode
  success: boolean
  cycles: number
  totalDurationMs: number
  totalContextBytes: number
  totalContextChars: number
  totalInputTokens?: number
  totalOutputTokens?: number
  totalTokens?: number
  finalStatus: string
  endedAt: string
}

interface PendingCycle {
  cycle: number
  failureSignature: string
  startedAtMs: number
  startedAt: string
  snapshot: BenchmarkContextSnapshot
  usageFile: string
  signalWritten: '.rerun' | '.restart' | null
}

export interface BenchmarkTracker {
  run: BenchmarkRunInfo
  cycles: BenchmarkCycleRecord[]
  pending: PendingCycle | null
  finalized: boolean
}

interface UsageTotals {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n')
}

function appendJsonLine(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.appendFileSync(file, JSON.stringify(value) + '\n')
}

function runPath(name: string): string {
  return path.join(BENCHMARK_DIR, name)
}

function sumUsage(file: string): UsageTotals {
  try {
    const raw = fs.readFileSync(file, 'utf-8')
    const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean)
    let inputTokens = 0
    let outputTokens = 0
    let hasInput = false
    let hasOutput = false

    for (const line of lines) {
      const item = JSON.parse(line) as { inputTokens?: unknown; outputTokens?: unknown }
      const input = Number(item.inputTokens)
      const output = Number(item.outputTokens)
      if (Number.isFinite(input)) {
        inputTokens += input
        hasInput = true
      }
      if (Number.isFinite(output)) {
        outputTokens += output
        hasOutput = true
      }
    }

    if (!hasInput && !hasOutput) return {}

    const usage: UsageTotals = {}
    if (hasInput) usage.inputTokens = inputTokens
    if (hasOutput) usage.outputTokens = outputTokens
    usage.totalTokens = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)
    return usage
  } catch {
    return {}
  }
}

export function createBenchmarkTracker(
  info: Omit<BenchmarkRunInfo, 'projectRoot'>,
): BenchmarkTracker {
  fs.rmSync(BENCHMARK_DIR, { recursive: true, force: true })
  fs.mkdirSync(path.join(BENCHMARK_DIR, 'context'), { recursive: true })
  fs.mkdirSync(path.join(BENCHMARK_DIR, 'usage'), { recursive: true })

  const run: BenchmarkRunInfo = {
    ...info,
    projectRoot: ROOT,
  }
  writeJson(runPath('run.json'), run)
  return {
    run,
    cycles: [],
    pending: null,
    finalized: false,
  }
}

export function benchmarkUsagePath(cycle: number): string {
  return path.join(BENCHMARK_DIR, 'usage', `cycle-${cycle}.jsonl`)
}

export function startBenchmarkCycle(
  tracker: BenchmarkTracker,
  cycle: number,
  failureSignature: string,
  snapshot: BenchmarkContextSnapshot,
): string {
  const usageFile = benchmarkUsagePath(cycle)
  fs.rmSync(usageFile, { force: true })
  tracker.pending = {
    cycle,
    failureSignature,
    startedAtMs: Date.now(),
    startedAt: new Date().toISOString(),
    snapshot,
    usageFile,
    signalWritten: null,
  }
  writeJson(path.join(BENCHMARK_DIR, 'context', `cycle-${cycle}.json`), snapshot)
  return usageFile
}

export function noteBenchmarkSignal(
  tracker: BenchmarkTracker,
  signal: '.rerun' | '.restart',
): void {
  if (!tracker.pending) return
  tracker.pending.signalWritten = signal
}

export function finalizeBenchmarkCycle(
  tracker: BenchmarkTracker,
  status: BenchmarkCycleRecord['status'],
  greenAfterCycle: boolean,
): BenchmarkCycleRecord | null {
  const pending = tracker.pending
  if (!pending) return null

  const usage = sumUsage(pending.usageFile)
  const record: BenchmarkCycleRecord = {
    runId: tracker.run.runId,
    cycle: pending.cycle,
    phase: 'auto-heal',
    startedAt: pending.startedAt,
    endedAt: new Date().toISOString(),
    durationMs: Date.now() - pending.startedAtMs,
    failureSignature: pending.failureSignature,
    signalWritten: pending.signalWritten,
    greenAfterCycle,
    summaryBytes: pending.snapshot.summaryBytes,
    slicedLogBytes: pending.snapshot.slicedLogBytes,
    journalBytes: pending.snapshot.journalBytes,
    rawServiceLogBytesAvailable: pending.snapshot.rawServiceLogBytesAvailable,
    filesIncluded: pending.snapshot.filesIncluded,
    contextBytes: pending.snapshot.contextBytes,
    contextChars: pending.snapshot.contextChars,
    success: greenAfterCycle,
    status,
    ...(usage.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
    ...(usage.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
    ...(usage.totalTokens !== undefined ? { totalTokens: usage.totalTokens } : {}),
  }

  tracker.cycles.push(record)
  tracker.pending = null
  appendJsonLine(runPath('cycles.jsonl'), record)
  return record
}

export function finalizeBenchmarkRun(
  tracker: BenchmarkTracker,
  finalStatus: string,
  success: boolean,
): BenchmarkFinalSummary | null {
  if (tracker.finalized) return null
  tracker.finalized = true

  const totalInputTokens = tracker.cycles.reduce((sum, cycle) => sum + (cycle.inputTokens ?? 0), 0)
  const totalOutputTokens = tracker.cycles.reduce((sum, cycle) => sum + (cycle.outputTokens ?? 0), 0)
  const hasTokenData = tracker.cycles.some(
    (cycle) => cycle.inputTokens !== undefined || cycle.outputTokens !== undefined,
  )

  const summary: BenchmarkFinalSummary = {
    runId: tracker.run.runId,
    feature: tracker.run.feature,
    benchmarkMode: tracker.run.benchmarkMode,
    success,
    cycles: tracker.cycles.length,
    totalDurationMs: tracker.cycles.reduce((sum, cycle) => sum + cycle.durationMs, 0),
    totalContextBytes: tracker.cycles.reduce((sum, cycle) => sum + cycle.contextBytes, 0),
    totalContextChars: tracker.cycles.reduce((sum, cycle) => sum + cycle.contextChars, 0),
    finalStatus,
    endedAt: new Date().toISOString(),
    ...(hasTokenData ? {
      totalInputTokens,
      totalOutputTokens,
      totalTokens: totalInputTokens + totalOutputTokens,
    } : {}),
  }

  writeJson(runPath('final-summary.json'), summary)
  return summary
}
