import type { ArmIterationResult, BenchmarkReport } from './report'
import type { LocalHealAgent } from '../../../orchestration/logic/runtime/manifest'

export type SabotageLevel = 'min' | 'med' | 'max'

/** Arm 'A' = Canary harness, arm 'B' = baseline (Playwright MCP only). */
export type BenchmarkArm = 'A' | 'B'
export type ArmMode = 'harness' | 'baseline'

export type BenchmarkStatus =
  | 'sabotaging' // worktree + sabotage agent + freeze
  | 'ready' // frozen, arms set up, awaiting the race
  | 'running' // arms racing
  | 'done' // all iterations complete, report written
  | 'invalid' // the frozen sabotage broke no test (caught in race iter 1) — re-run
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
  /** Resolved localPath of the sabotaged repo (feature.repos[0]). The sabotage
   *  commit lives here — which may be a DIFFERENT git repo than `featureDir`
   *  (external feature dirs are supported). "Open frozen bug" must worktree this
   *  repo, not `featureDir`, or `git worktree add <sabotageSha>` fails with
   *  "invalid reference" for multi-repo features. */
  repoPath?: string
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
  /** True once the user has reclaimed this benchmark's worktrees (staging, arm,
   *  inspect). Worktrees are kept after a run so "Open frozen bug" + arm
   *  inspection keep working; clearing is an explicit, user-driven action. Once
   *  set, those open actions are no longer available. */
  worktreesCleared?: boolean
  /** Disk reclaimed by the clear, for the post-clear receipt line. */
  worktreesClearedBytes?: number
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
  /** Heal agent to pin for BOTH arms + the sabotage agent. Chosen per-benchmark
   *  (not inherited from the project's global heal-agent setting) so a run is
   *  reproducible and always local-auto (never external). Falls back to the
   *  first available CLI when omitted. */
  agent?: 'claude' | 'codex'
}

export interface StartBenchmarkResult {
  benchmarkId: string
}
