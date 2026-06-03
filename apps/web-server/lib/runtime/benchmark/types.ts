import type { ArmIterationResult, BenchmarkReport } from './report'
import type { LocalHealAgent } from '../manifest'

export type SabotageLevel = 'min' | 'med' | 'max'

/** Arm 'A' = Canary harness, arm 'B' = baseline (Playwright MCP only). */
export type BenchmarkArm = 'A' | 'B'
export type ArmMode = 'harness' | 'baseline'

export type BenchmarkStatus =
  | 'sabotaging' // worktree + sabotage agent + validity gate
  | 'ready' // frozen, arms set up, awaiting the race
  | 'running' // arms racing
  | 'done' // all iterations complete, report written
  | 'aborted'
  | 'error'

export interface BenchmarkArmState {
  arm: BenchmarkArm
  mode: ArmMode
  /** Per-run worktree root, checked out at the sabotage SHA. */
  worktreePath?: string
  /** runId per iteration (index 0 = iteration 1). Arms are real runs. */
  runIds: string[]
}

export interface BenchmarkManifest {
  benchmarkId: string
  feature: string
  featureDir?: string
  /** Sabotage skill name (folder under sabotage-skills/). */
  skill: string
  level: SabotageLevel
  iterations: number
  agent: LocalHealAgent
  /** Pinned model recorded for fairness/audit. */
  model?: string
  status: BenchmarkStatus
  /** Frozen broken-state commit; both arms derive from this. */
  sabotageSha?: string
  startedAt: string
  endedAt?: string
  /** 1-based current iteration; 0 before the race starts. */
  currentIteration: number
  arms: BenchmarkArmState[]
  /** Accumulates as arm iterations finish. */
  results: ArmIterationResult[]
  report?: BenchmarkReport
  error?: string
}

export interface BenchmarkIndexEntry {
  benchmarkId: string
  feature: string
  level: SabotageLevel
  status: BenchmarkStatus
  startedAt: string
  endedAt?: string
}

/** Request body for starting a benchmark (POST /api/benchmarks). */
export interface StartBenchmarkInput {
  feature: string
  skill: string
  level: SabotageLevel
  iterations: number
}

export interface StartBenchmarkResult {
  benchmarkId: string
}
