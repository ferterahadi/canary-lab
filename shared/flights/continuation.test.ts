import { describe, expect, it } from 'vitest'
import { recommendFlightContinuation, type FlightWorkspaceEvidence } from './continuation'
import type { FlightStageKey } from './types'

const completeEvidence = (): FlightWorkspaceEvidence => ({
  'env-capture': { captured: 2 },
  docs: { docs: ['requirements.md'] },
  'prd-summary': { requirementCount: 6 },
  'specs-coverage': { mappingState: 'fresh', coveragePct: 100, testsWritten: 8 },
  run: { runId: 'run-green', status: 'passed' },
  robustness: { cellsRun: 4 },
  'evaluation-export': { taskId: 'export-1' },
  portify: { declaredInjectable: 2 },
})

describe('recommendFlightContinuation', () => {
  it('names the first missing setup, requirements, coverage, or proof prerequisite', () => {
    const prerequisites: Array<[FlightWorkspaceEvidence, number, FlightStageKey]> = [
      [{}, 100, 'env-capture'],
      [{ 'env-capture': { captured: 1 } }, 100, 'docs'],
      [{ 'env-capture': { captured: 1 }, docs: { docs: ['requirements.md'] } }, 100, 'prd-summary'],
      [{ 'env-capture': { captured: 1 }, docs: { docs: ['requirements.md'] }, 'prd-summary': { requirementCount: 1 } }, 100, 'specs-coverage'],
      [{ ...completeEvidence(), 'specs-coverage': { mappingState: 'fresh', coveragePct: 100, testsWritten: 0 } }, 100, 'specs-coverage'],
      [{ ...completeEvidence(), 'specs-coverage': { mappingState: 'fresh', coveragePct: Number.NaN, testsWritten: 1 } }, 100, 'specs-coverage'],
      [{ ...completeEvidence(), 'specs-coverage': { coveragePct: 100, testsWritten: 1 } }, 100, 'specs-coverage'],
      [{ ...completeEvidence(), run: { status: 'failed' } }, 100, 'run'],
      [{ ...completeEvidence(), 'evaluation-export': undefined }, 100, 'evaluation-export'],
      [{ ...completeEvidence(), portify: undefined }, 100, 'portify'],
    ]

    for (const [evidence, target, stage] of prerequisites) {
      expect(recommendFlightContinuation(evidence, target)?.fromStage).toBe(stage)
    }
  })

  it('re-enters Tests and coverage when valid prior mapping is below the requested target', () => {
    const evidence = completeEvidence()
    evidence['specs-coverage'] = { mappingState: 'fresh', coveragePct: 83.3, testsWritten: 7 }

    expect(recommendFlightContinuation(evidence, 100)).toEqual({
      fromStage: 'specs-coverage',
      reason: 'semantic coverage is 83.3%; the requested target is 100%',
    })
  })

  it('does not reopen coverage when the same evidence meets the requested target', () => {
    const evidence = completeEvidence()
    evidence['specs-coverage'] = { mappingState: 'fresh', coveragePct: 83.3, testsWritten: 7 }

    expect(recommendFlightContinuation(evidence, 80)).toBeNull()
  })

  it('selects the first missing downstream result in execution order', () => {
    const evidence = completeEvidence()
    delete evidence.robustness
    delete evidence['evaluation-export']

    expect(recommendFlightContinuation(evidence, 100)?.fromStage).toBe('robustness')
  })

  it('explains stale mapping separately from the displayed percentage', () => {
    const evidence = completeEvidence()
    evidence['specs-coverage'] = { mappingState: 'stale', coveragePct: 100, testsWritten: 8 }

    expect(recommendFlightContinuation(evidence, 100)).toEqual({
      fromStage: 'specs-coverage',
      reason: 'semantic coverage mapping is stale; it must be refreshed before the 100% target can count',
    })
  })

  it('returns null when the requested Flight outcome is already complete', () => {
    expect(recommendFlightContinuation(completeEvidence(), 100)).toBeNull()
  })
})
