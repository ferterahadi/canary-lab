import type { CoverageJobIndexEntry } from '@shared/coverage/types'
import type { DraftRecord, ExternalDraftStage } from '@shared/draft-types'
import type { EvaluationExportStatus } from '@shared/evaluation-export-types'
import type { PortifyStatus } from '@shared/portify-index'

// One lifecycle vocabulary for agent work, whatever store it lives in: the
// flight's activity traces read it, and every agent-job status pill and table
// cell colours by it, so a portify, draft, coverage or export job in progress
// is the same sky everywhere and a ready one the same green.
export type AgentJobStatus = 'running' | 'ready' | 'done' | 'failed' | 'aborted'

// The status hues (docs/DESIGN-SYSTEM.md): sky in progress, green for a
// result that exists, rose for an error, muted for a cancelled job. Accent
// blue is never a status.
export const AGENT_JOB_COLOR: Record<AgentJobStatus, string> = {
  running: 'var(--running)',
  ready: 'var(--success)',
  done: 'var(--success)',
  failed: 'var(--danger)',
  aborted: 'var(--text-muted)',
}

export function draftTraceStatus(status: DraftRecord['status']): AgentJobStatus {
  if (status === 'planning' || status === 'generating') return 'running'
  if (status === 'accepted') return 'done'
  if (status === 'error') return 'failed'
  if (status === 'cancelled' || status === 'rejected') return 'aborted'
  return 'ready'
}

export function backgroundTraceStatus(status: CoverageJobIndexEntry['status']): AgentJobStatus {
  if (status === 'running') return 'running'
  if (status === 'done') return 'done'
  if (status === 'failed') return 'failed'
  return 'aborted'
}

export function portifyTraceStatus(status: PortifyStatus): AgentJobStatus {
  if (status === 'saved') return 'done'
  if (status === 'failed') return 'failed'
  if (status === 'aborted') return 'aborted'
  if (status === 'ready-to-save') return 'ready'
  return 'running'
}

/** The stage an external client reports while it authors a draft. */
export function externalDraftStageStatus(stage: ExternalDraftStage): AgentJobStatus {
  if (stage === 'error') return 'failed'
  if (stage === 'applied') return 'done'
  if (stage === 'ready') return 'ready'
  return 'running'
}

export function evaluationExportStatus(status: EvaluationExportStatus): AgentJobStatus {
  if (status === 'completed') return 'ready'
  if (status === 'failed') return 'failed'
  return 'running'
}
