import type { RunManifest } from './run-manifest'
import type { TestReviewReceipt } from './test-review'

/** One server observation; approval, source drift and execution are distinct facts. */
export interface RunCollaborationState {
  runId: string
  revision: string
  status: RunManifest['status']
  execution: number
  owner?: RunManifest['externalHealSession']
  review: {
    state: 'pending' | 'accepted' | 'settled' | 'unavailable'
    revision?: string
    changedFiles: number
    receipt?: TestReviewReceipt
  }
  continuation: { available: boolean; reason?: string; requiresNewRun: boolean }
}

export interface RunExecutionEvidence {
  index: number
  sourceVersion?: string
  startedAt?: string
  recovered?: boolean
  targets?: string[]
  grep?: string
  endedAt?: string
  exitCode?: number
  selection: 'full-suite' | 'targeted' | 'unavailable'
  outputPath: string
  summaryPath?: string
}

export interface RunUpdate {
  feature: string
  revision: string
  runs: RunCollaborationState[]
}

export interface RunHistoryEntry {
  runId: string
  feature: string
  continuationOf?: string
  status: RunManifest['status']
  startedAt: string
  executions: RunExecutionEvidence[]
  journal: import('./run-detail').JournalSection[]
}
