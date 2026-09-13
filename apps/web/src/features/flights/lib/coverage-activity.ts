import type { CoverageJobIndexEntry } from '@/shared/api/types'
import type { FlightStageKey } from '@/shared/api/client'
import type { AgentSessionSegmentSource } from '@/shared/ui/AgentSessionView'

export function coverageJobStage(job: CoverageJobIndexEntry): FlightStageKey {
  return job.kind === 'summary' ? 'docs' : 'specs-coverage'
}

export function stageCoverageJobs(jobs: CoverageJobIndexEntry[], feature: string, stage: FlightStageKey): CoverageJobIndexEntry[] {
  return jobs.filter((job) => job.feature === feature && coverageJobStage(job) === stage)
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.jobId.localeCompare(b.jobId))
}

export function coverageSessionSources(jobs: CoverageJobIndexEntry[]): AgentSessionSegmentSource[] {
  return jobs.filter((job) => job.producer !== 'external').map((job) => ({
    label: job.kind === 'summary' ? 'Summarizing docs' : 'Mapping coverage',
    startedAt: job.startedAt,
    source: { kind: 'coverage', jobId: job.jobId, live: job.status === 'running' },
  }))
}
