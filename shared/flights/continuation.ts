import type { FlightStageKey } from './types'

export type FlightWorkspaceEvidence = Partial<Record<FlightStageKey, Record<string, unknown>>>

export interface FlightContinuationRecommendation {
  fromStage: FlightStageKey
  reason: string
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * Find the first pipeline stage whose durable workspace evidence does not meet
 * the requested Flight outcome. This is deliberately target-aware: a fresh
 * semantic mapping at 83.3% is real evidence, but it does not satisfy a new
 * request to drive coverage to 100%.
 *
 * Similarity/scout/scaffold are already represented by the configured feature
 * that the entry route resolved. Every later answer comes from the same
 * workspace probes used by the derived Flight view; no agent self-report is
 * accepted here.
 */
export function recommendFlightContinuation(
  evidence: FlightWorkspaceEvidence,
  coverageTarget: number,
): FlightContinuationRecommendation | null {
  if (!evidence['env-capture']) {
    return { fromStage: 'env-capture', reason: 'suite setup has not been proven for this environment' }
  }
  if (!evidence['prd-summary']) {
    return evidence.docs
      ? { fromStage: 'prd-summary', reason: 'requirement sources exist but no distilled requirement summary is current' }
      : { fromStage: 'docs', reason: 'no requirement sources or distilled requirement summary are present' }
  }

  const coverage = evidence['specs-coverage']
  const coveragePct = finiteNumber(coverage?.coveragePct)
  const testsWritten = finiteNumber(coverage?.testsWritten)
  if (!coverage || testsWritten === null || testsWritten < 1 || coveragePct === null) {
    const measured = coveragePct === null ? 'unmeasured' : `${coveragePct}%`
    return {
      fromStage: 'specs-coverage',
      reason: `semantic coverage is ${measured}; the requested target is ${coverageTarget}%`,
    }
  }
  if (coverage.mappingState !== 'fresh') {
    const state = typeof coverage.mappingState === 'string' ? coverage.mappingState : 'absent'
    return {
      fromStage: 'specs-coverage',
      reason: `semantic coverage mapping is ${state}; it must be refreshed before the ${coverageTarget}% target can count`,
    }
  }
  if (coveragePct < coverageTarget) {
    return {
      fromStage: 'specs-coverage',
      reason: `semantic coverage is ${coveragePct}%; the requested target is ${coverageTarget}%`,
    }
  }

  if (evidence.run?.status !== 'passed') {
    return { fromStage: 'run', reason: 'there is no passing feature run for the current suite' }
  }
  if (!evidence.robustness) {
    return { fromStage: 'robustness', reason: 'no completed Robustness Lab result is present' }
  }
  if (!evidence['evaluation-export']) {
    return { fromStage: 'evaluation-export', reason: 'no completed evaluation Report is present' }
  }
  if (!evidence.portify) {
    return { fromStage: 'portify', reason: 'Parallel setup has not been completed' }
  }
  return null
}
