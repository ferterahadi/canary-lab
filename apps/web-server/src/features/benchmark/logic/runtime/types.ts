import type { SabotageLevel } from '../../../../../../../shared/benchmark-index'

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
