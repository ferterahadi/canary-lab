import { describe, expect, it } from 'vitest'
import type { CoverageJobIndexEntry } from '@/shared/api/types'
import { coverageJobStage, coverageSessionSources, stageCoverageJobs } from './coverage-activity'

const job: CoverageJobIndexEntry = { jobId: 'j1', feature: 'checkout', kind: 'summary', status: 'done', startedAt: '2026-09-11T00:00:00Z' }

describe('coverage activity ownership', () => {
  it('assigns each phase to its visible Flight row', () => {
    expect(coverageJobStage(job)).toBe('docs')
    expect(coverageJobStage({ ...job, kind: 'coverage' })).toBe('specs-coverage')
  })
  it('retains ordered history for only this feature and stage', () => {
    const later = { ...job, jobId: 'j2', startedAt: '2026-09-11T00:01:00Z' }
    expect(stageCoverageJobs([later, { ...job, feature: 'other' }, { ...job, kind: 'coverage' }, job], 'checkout', 'docs')).toEqual([job, later])
  })
  it('tails only running internal sessions and leaves external jobs to the existing external Activity rows', () => {
    const sessions = coverageSessionSources([job, { ...job, jobId: 'j2', kind: 'coverage', status: 'running' }, { ...job, producer: 'external' }])
    expect(sessions).toEqual([
      { label: 'Summarizing docs', startedAt: job.startedAt, source: { kind: 'coverage', jobId: 'j1', live: false } },
      { label: 'Mapping coverage', startedAt: job.startedAt, source: { kind: 'coverage', jobId: 'j2', live: true } },
    ])
  })
})
