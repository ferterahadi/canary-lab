// Pure aggregation: turn per-arm, per-iteration benchmark results into the
// comparison report. No I/O — fully unit-testable. Arm 'A' = Canary harness,
// arm 'B' = baseline (Playwright MCP only).

export interface ArmIterationResult {
  arm: 'A' | 'B'
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

function summarizeArm(results: ArmIterationResult[], arm: 'A' | 'B'): ArmSummary {
  const rows = results.filter((r) => r.arm === arm)
  const tokenVals = rows.map((r) => r.tokens).filter((t): t is number => t != null)
  return {
    iterationsHealed: rows.filter((r) => r.healed).length,
    iterationsTotal: rows.length,
    avgHealCycles: rows.length
      ? rows.reduce((sum, r) => sum + r.healCycles, 0) / rows.length
      : 0,
    totalWallClockMs: rows.reduce((sum, r) => sum + r.wallClockMs, 0),
    totalTokens: tokenVals.length
      ? tokenVals.reduce((sum, t) => sum + t, 0)
      : undefined,
  }
}

export function computeBenchmarkReport(results: ArmIterationResult[]): BenchmarkReport {
  const harness = summarizeArm(results, 'A')
  const baseline = summarizeArm(results, 'B')
  return {
    harness,
    baseline,
    reliabilityMultiple:
      baseline.iterationsHealed > 0
        ? harness.iterationsHealed / baseline.iterationsHealed
        : null,
  }
}
