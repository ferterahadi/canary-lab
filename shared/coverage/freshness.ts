export const COVERAGE_RECONCILE_MS = 5_000
export const COVERAGE_FRESHNESS_LEASE_MS = 15_000

export type CoverageRecoveryStage = 'prd-summary' | 'specs-coverage' | 'run'

export interface CoverageRecoveryAction {
  stage: CoverageRecoveryStage
  label: string
  command: 'start_external_summary' | 'start_external_coverage' | 'start_run'
  arguments: { feature: string }
}

/** Freshness qualifies the measurements; it never turns a missing result into
 * zero coverage or a failed execution into a pass. */
export interface CoverageFreshness {
  revision: string
  checkedAt: string
  state: 'current' | 'stale' | 'unavailable' | 'updating' | 'not-measured'
  reasons: string[]
  changedTests: string[]
  nextAction?: CoverageRecoveryAction
  latestRunId?: string
  latestRunStatus?: string
  evidenceRunId?: string
  latestRunFailed: boolean
  proofNeedsRun: boolean
}

export interface FeatureCoverageChange {
  feature: string
  freshness: CoverageFreshness
  flightId?: string
  activeJobId?: string
  activeJobOwner?: string
  flightStatus?: string
  measurement?: { coveragePct: number; covered: number; total: number; tests: number }
  delivery: 'tool-response-and-wait'
}
