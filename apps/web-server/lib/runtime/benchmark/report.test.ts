import { describe, it, expect } from 'vitest'
import { computeBenchmarkReport, type ArmIterationResult } from './report'

function r(
  arm: 'A' | 'B',
  iteration: number,
  healed: boolean,
  healCycles: number,
  wallClockMs: number,
  tokens?: number,
): ArmIterationResult {
  return { arm, iteration, healed, healCycles, wallClockMs, tokens }
}

describe('computeBenchmarkReport', () => {
  it('counts iterations healed per arm (harness=A, baseline=B)', () => {
    const report = computeBenchmarkReport([
      r('A', 1, true, 2, 38_000),
      r('A', 2, true, 2, 44_000),
      r('B', 1, false, 5, 182_000),
      r('B', 2, true, 4, 94_000),
    ])
    expect(report.harness.iterationsHealed).toBe(2)
    expect(report.harness.iterationsTotal).toBe(2)
    expect(report.baseline.iterationsHealed).toBe(1)
    expect(report.baseline.iterationsTotal).toBe(2)
  })

  it('averages heal cycles and totals time/tokens across all iterations per arm', () => {
    const report = computeBenchmarkReport([
      r('A', 1, true, 2, 38_000, 71_000),
      r('A', 2, true, 2, 44_000, 69_000),
      r('B', 1, false, 5, 182_000, 120_000),
      r('B', 2, true, 4, 94_000, 98_000),
    ])
    expect(report.harness.avgHealCycles).toBe(2)
    expect(report.harness.totalWallClockMs).toBe(82_000)
    expect(report.harness.totalTokens).toBe(140_000)
    expect(report.baseline.avgHealCycles).toBe(4.5)
    expect(report.baseline.totalWallClockMs).toBe(276_000)
    expect(report.baseline.totalTokens).toBe(218_000)
  })

  it('reports reliability multiple = harness healed / baseline healed', () => {
    const report = computeBenchmarkReport([
      r('A', 1, true, 2, 38_000),
      r('A', 2, true, 2, 44_000),
      r('B', 1, false, 5, 182_000),
      r('B', 2, true, 4, 94_000),
    ])
    expect(report.reliabilityMultiple).toBe(2)
  })

  it('reliability multiple is null when baseline never healed (no divide-by-zero)', () => {
    const report = computeBenchmarkReport([
      r('A', 1, true, 2, 38_000),
      r('B', 1, false, 5, 182_000),
    ])
    expect(report.reliabilityMultiple).toBeNull()
  })
})
