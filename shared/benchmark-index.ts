import type { RecordIndexFrame } from './record-index-frame'
import type { LocalHealAgent } from './run-manifest'

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

/** Arm 'A' = Canary harness, arm 'B' = baseline (Playwright MCP only). */
export type BenchmarkArm = 'A' | 'B'
export type ArmMode = 'harness' | 'baseline'

export interface ArmIterationResult {
  arm: BenchmarkArm
  iteration: number
  healed: boolean
  /** Heal cycles to green when healed, or cycles spent before timeout/failure. */
  healCycles: number
  wallClockMs: number
  tokens?: number
}

export interface ArmSummary {
  iterationsHealed: number
  iterationsTotal: number
  /** Mean heal cycles across ALL iterations (healed + failed). 0 when none. */
  avgHealCycles: number
  totalWallClockMs: number
  /** Sum of per-iteration tokens; undefined when no iteration reported tokens. */
  totalTokens?: number
}

export interface BenchmarkReport {
  harness: ArmSummary
  baseline: ArmSummary
  /** Headline: harness iterations-healed ÷ baseline iterations-healed.
   *  null when baseline healed zero (an unbounded multiple — UI shows it
   *  as "baseline never healed" rather than ∞). */
  reliabilityMultiple: number | null
}

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

/** Picker view of a sabotage skill (GET /api/benchmark-skills). */
export interface SabotageSkillSummary {
  name: string
  title: string
  level: SabotageLevel
  summary: string
  description: string
  /** The exact instructions handed to the sabotage agent. */
  recipe: string
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

/** `/ws/benchmark` frames. */
export type BenchmarkStreamFrame = RecordIndexFrame<BenchmarkIndexEntry, BenchmarkManifest, 'benchmarks', 'benchmarkId'>
