import { describe, expect, it } from 'vitest'
import type { RunIndexEntry } from '@shared/run-index'
import { featureTestRuns } from './feature-test-runs'

const run = (runId: string, startedAt: string, executionType?: RunIndexEntry['executionType'], feature = 'checkout'): RunIndexEntry => ({
  runId, startedAt, executionType, feature, status: 'passed',
})

describe('suite test history', () => {
  it('includes normal, legacy and Verify runs with deterministic ordering without mutating the index', () => {
    const entries = [run('a', '2026-01-02'), run('legacy', '2026-01-01'), run('z', '2026-01-02', 'verify'),
      run('boot', '2026-01-03', 'boot'), run('benchmark', '2026-01-03', 'benchmark'),
      run('cell', '2026-01-03', 'robustness'), run('other', '2026-01-04', 'run', 'other')]
    expect(featureTestRuns(entries, 'checkout').map((entry) => entry.runId)).toEqual(['z', 'a', 'legacy'])
    expect(entries[0].runId).toBe('a')
    expect(featureTestRuns(entries, 'absent')).toEqual([])
  })
})
