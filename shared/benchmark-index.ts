export type SabotageLevel = 'min' | 'med' | 'max'

export type BenchmarkStatus =
  | 'sabotaging' // worktree + sabotage agent + freeze
  | 'ready' // frozen, arms set up, awaiting the race
  | 'running' // arms racing
  | 'done' // all iterations complete, report written
  | 'invalid' // the frozen sabotage broke no test (caught in race iter 1) — re-run
  | 'aborted'
  | 'error'

export interface BenchmarkIndexEntry {
  benchmarkId: string
  feature: string
  level: SabotageLevel
  status: BenchmarkStatus
  startedAt: string
  endedAt?: string
}

export function benchmarkIndexEntry(manifest: BenchmarkIndexEntry): BenchmarkIndexEntry {
  return {
    benchmarkId: manifest.benchmarkId,
    feature: manifest.feature,
    level: manifest.level,
    status: manifest.status,
    startedAt: manifest.startedAt,
    ...(manifest.endedAt ? { endedAt: manifest.endedAt } : {}),
  }
}

export function isActiveBenchmarkStatus(status: string | undefined): boolean {
  return status === 'sabotaging' || status === 'ready' || status === 'running'
}

export function isTerminalBenchmarkStatus(status: string | undefined): boolean {
  return status === 'done' || status === 'invalid' || status === 'aborted' || status === 'error'
}
