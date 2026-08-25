import type { ClientKind, RunProducer } from '../../../../../../shared/run-mode'

export type EvaluationExportMode = 'raw' | 'localized'
export type EvaluationExportStatus = 'running' | 'completed' | 'failed'
export type EvaluationExportProducer = RunProducer

/** Counts content that was actually written to the archive, not merely found in the run. */
export interface EvaluationArchiveContents {
  /** Byte length of the built zip. */
  bytes: number
  /** Playwright videos bundled alongside the report. */
  videos: number
  /** The report's own assets, such as styles and referenced inline media. */
  assets: number
}

export interface EvaluationExportSessionRef {
  agent: 'claude' | 'codex'
  sessionId: string
}

export interface EvaluationExportTaskRecord {
  taskId: string
  runId: string
  feature: string
  mode: EvaluationExportMode
  producer?: EvaluationExportProducer
  status: EvaluationExportStatus
  createdAt: string
  updatedAt: string
  downloadReady: boolean
  archiveBase: string
  clientKind?: ClientKind
  sessionId?: string
  conversationName?: string
  language?: string
  externalSessionUrl?: string
  error?: string
  /** Set only when a local rewrite agent was started for this export. */
  sessionRef?: EvaluationExportSessionRef
  /** Recorded after the archive is written; absent for older or unfinished tasks. */
  archive?: EvaluationArchiveContents
}

export interface EvaluationExportTaskView {
  taskId: string
  runId: string
  feature: string
  mode: EvaluationExportMode
  producer: EvaluationExportProducer
  status: EvaluationExportStatus
  createdAt: string
  updatedAt: string
  downloadReady: boolean
  clientKind?: ClientKind
  sessionId?: string
  conversationName?: string
  language?: string
  externalSessionUrl?: string
  error?: string
  sessionRef?: EvaluationExportSessionRef
  archive?: EvaluationArchiveContents
}
