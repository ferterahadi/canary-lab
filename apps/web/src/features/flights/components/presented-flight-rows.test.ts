import { describe, expect, it } from 'vitest'
import type { FlightManifest } from '@/shared/api/client'
import { FLIGHT_STAGE_KEYS } from '@shared/flights/types'
import { presentedIndexStages } from '../lib/external-work'
import { flightIndexEntry } from '../state/flights-stream-state'
import { presentedFlightRows } from './presented-flight-rows'

const startedAt = '2026-09-23T00:00:00Z'
const jobStartedAt = '2026-09-24T00:00:00Z'

function manifest(): FlightManifest {
  return {
    flightId: 'fl_checkout', feature: 'checkout', repoPaths: [], description: '',
    opts: { env: 'local', coverageTarget: 100, yolo: false },
    status: 'paused', currentStage: 'run', createdAt: startedAt, updatedAt: startedAt,
    stages: FLIGHT_STAGE_KEYS.map((key) => ({
      key, startedAt,
      status: key === 'run' || key === 'scaffold' || key === 'env-capture'
        || key === 'docs' || key === 'prd-summary' || key === 'specs-coverage' || key === 'portify'
        ? 'skipped' as const
        : key === 'evaluation-export' ? 'failed' as const
          : key === 'robustness' ? 'pending' as const : 'done' as const,
      ...(key === 'scaffold' || key === 'env-capture' || key === 'docs'
        || key === 'prd-summary' || key === 'specs-coverage' || key === 'portify'
        ? { evidence: { captured: 1 } } : {}),
    })),
  }
}

describe('presented Flight rows', () => {
  it('resolves every picker step from the same evidence and live work as the detail rail', () => {
    const flight = manifest()
    const activity = { kind: 'running' as const, runId: 'run-1' }
    const coverageJobs = [
      { jobId: 'summary-1', feature: 'checkout', kind: 'summary' as const, status: 'running' as const, startedAt: jobStartedAt },
      { jobId: 'mapping-1', feature: 'checkout', kind: 'coverage' as const, status: 'failed' as const, startedAt: jobStartedAt },
    ]
    const portifyWorkflows = [{ workflowId: 'port-1', feature: 'checkout', status: 'ready-to-save' as const, startedAt: jobStartedAt }]
    const detail = presentedFlightRows({ feature: flight.feature, stages: flight.stages, activity, coverageJobs, portifyWorkflows })
    const picker = presentedFlightRows({
      feature: flight.feature,
      stages: presentedIndexStages(flightIndexEntry(flight)),
      activity, coverageJobs, portifyWorkflows, fillMissingStages: true,
    })

    expect(picker.map(({ key, status }) => [key, status])).toEqual(detail.map(({ key, status }) => [key, status]))
    expect(picker.map(({ key, status }) => [key, status])).toEqual([
      ['scout', 'done'], ['scaffold', 'done'], ['docs', 'running'],
      ['specs-coverage', 'failed'], ['run', 'running'], ['evaluation-export', 'failed'],
      ['portify', 'waiting-for-approval'], ['robustness', 'pending'],
    ])
    expect(flight.stages.find((stage) => stage.key === 'specs-coverage')?.status).toBe('skipped')
  })

  it('keeps a newer recorded step above an older failed coverage job', () => {
    const flight = manifest()
    flight.stages = flight.stages.map((stage) => stage.key === 'prd-summary'
      ? { ...stage, startedAt: jobStartedAt }
      : stage)
    const coverageJobs = [{
      jobId: 'summary-old', feature: 'checkout', kind: 'summary' as const,
      status: 'failed' as const, startedAt,
    }]
    const detail = presentedFlightRows({ feature: flight.feature, stages: flight.stages, coverageJobs })
    const picker = presentedFlightRows({
      feature: flight.feature, stages: presentedIndexStages(flightIndexEntry(flight)),
      coverageJobs, fillMissingStages: true,
    })
    expect(detail.find((row) => row.key === 'docs')?.status).toBe('done')
    expect(picker.find((row) => row.key === 'docs')?.status).toBe('done')
  })
})
