import { describe, expect, it } from 'vitest'
import type { CoverageJobStatus } from '@shared/coverage/types'
import type { DraftStatus, ExternalDraftStage } from '@shared/draft-types'
import type { EvaluationExportStatus } from '@shared/evaluation-export-types'
import type { PortifyStatus } from '@shared/portify-index'
import {
  AGENT_JOB_COLOR,
  backgroundTraceStatus,
  draftTraceStatus,
  evaluationExportStatus,
  externalDraftStageStatus,
  portifyTraceStatus,
  type AgentJobStatus,
} from './agent-job-status'

// Each table lists every member of the source union, so a status added to a
// store without a decision here fails `tsc` on the Record, not silently at
// runtime.
const DRAFT: Record<DraftStatus, AgentJobStatus> = {
  created: 'ready',
  planning: 'running',
  'plan-ready': 'ready',
  generating: 'running',
  'spec-ready': 'ready',
  accepted: 'done',
  rejected: 'aborted',
  cancelled: 'aborted',
  error: 'failed',
}
const COVERAGE: Record<CoverageJobStatus, AgentJobStatus> = {
  running: 'running', done: 'done', failed: 'failed', aborted: 'aborted',
}
const PORTIFY: Record<PortifyStatus, AgentJobStatus> = {
  planning: 'running',
  editing: 'running',
  verifying: 'running',
  'ready-to-save': 'ready',
  saved: 'done',
  failed: 'failed',
  aborted: 'aborted',
}
const EXTERNAL_DRAFT: Record<ExternalDraftStage, AgentJobStatus> = {
  scaffolding: 'running',
  'authoring-tests': 'running',
  validating: 'running',
  ready: 'ready',
  applied: 'done',
  error: 'failed',
}
const EXPORT: Record<EvaluationExportStatus, AgentJobStatus> = {
  running: 'running', completed: 'ready', failed: 'failed',
}

describe('agent job status', () => {
  it.each([
    ['draft', draftTraceStatus, DRAFT],
    ['coverage job', backgroundTraceStatus, COVERAGE],
    ['portify workflow', portifyTraceStatus, PORTIFY],
    ['external draft stage', externalDraftStageStatus, EXTERNAL_DRAFT],
    ['evaluation export', evaluationExportStatus, EXPORT],
  ] as const)('maps every %s status onto the one lifecycle', (_name, map, expected) => {
    for (const [status, job] of Object.entries(expected)) {
      expect((map as (s: string) => AgentJobStatus)(status), status).toBe(job)
    }
  })

  it('colours work in progress sky and a ready result green, never accent blue', () => {
    expect(AGENT_JOB_COLOR).toEqual({
      running: 'var(--running)',
      ready: 'var(--success)',
      done: 'var(--success)',
      failed: 'var(--danger)',
      aborted: 'var(--text-muted)',
    })
  })
})
