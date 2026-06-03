// Front-end mirror of the server-side benchmark wire shapes
// (apps/web-server/lib/runtime/benchmark/{types,report}.ts), matching the way
// api/types.ts mirrors the run shapes. Keep field-for-field in sync.

export type SabotageLevel = 'min' | 'med' | 'max'
export type BenchmarkArm = 'A' | 'B'
export type ArmMode = 'harness' | 'baseline'
export type BenchmarkStatus =
  | 'sabotaging'
  | 'ready'
  | 'running'
  | 'done'
  | 'aborted'
  | 'error'

export interface ArmIterationResult {
  arm: BenchmarkArm
  iteration: number
  healed: boolean
  healCycles: number
  wallClockMs: number
  tokens?: number
}

export interface ArmSummary {
  iterationsHealed: number
  iterationsTotal: number
  avgHealCycles: number
  totalWallClockMs: number
  totalTokens?: number
}

export interface BenchmarkReport {
  harness: ArmSummary
  baseline: ArmSummary
  reliabilityMultiple: number | null
}

export interface BenchmarkArmState {
  arm: BenchmarkArm
  mode: ArmMode
  worktreePath?: string
  runIds: string[]
}

export interface BenchmarkManifest {
  benchmarkId: string
  feature: string
  featureDir?: string
  skill: string
  level: SabotageLevel
  iterations: number
  agent: 'claude' | 'codex'
  model?: string
  status: BenchmarkStatus
  sabotageSha?: string
  startedAt: string
  endedAt?: string
  currentIteration: number
  arms: BenchmarkArmState[]
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
