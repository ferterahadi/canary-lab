import { describe, expect, it } from 'vitest'
import { isSuiteVerdictRun } from './run-index'

describe('isSuiteVerdictRun', () => {
  it('accepts a normal run whose status is in the set', () => {
    expect(isSuiteVerdictRun({ status: 'passed' }, ['passed'])).toBe(true)
    expect(isSuiteVerdictRun({ executionType: 'run', status: 'failed' }, ['passed', 'failed'])).toBe(true)
  })

  it('rejects a status outside the set', () => {
    expect(isSuiteVerdictRun({ executionType: 'run', status: 'aborted' }, ['passed', 'failed'])).toBe(false)
    expect(isSuiteVerdictRun({ status: 'running' }, ['passed'])).toBe(false)
  })

  it('rejects auxiliary and observational runs even when their status matches', () => {
    for (const executionType of ['boot', 'benchmark', 'robustness', 'verify'] as const) {
      expect(isSuiteVerdictRun({ executionType, status: 'passed' }, ['passed'])).toBe(false)
    }
  })
})
