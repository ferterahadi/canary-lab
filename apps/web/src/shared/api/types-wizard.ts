import type { RunProducer } from '@shared/run-mode'
import type { ExternalHealClientKind } from './types-runs'

export type DraftStatus =
  | 'created'
  | 'planning'
  | 'plan-ready'
  | 'generating'
  | 'spec-ready'
  | 'accepted'
  | 'rejected'
  | 'cancelled'
  | 'error'

export type DraftSource = RunProducer

export type ExternalDraftStage =
  | 'scaffolding'
  | 'authoring-tests'
  | 'validating'
  | 'ready'
  | 'applied'
  | 'error'

export interface DraftRepo {
  name: string
  localPath: string
  branch?: string
}

export interface DraftRecord {
  draftId: string
  prdText: string
  additionalNotes?: string
  prdDocuments: DraftPrdDocument[]
  repos: DraftRepo[]
  featureName?: string
  producer?: DraftSource
  externalStage?: ExternalDraftStage
  externalClientKind?: ExternalHealClientKind
  externalSessionId?: string
  externalConversationName?: string
  externalSessionUrl?: string
  intentSummary?: string
  activeAgentStage?: 'planning' | 'generating'
  planAgentSessionId?: string
  planAgentSessionKind?: 'claude' | 'codex'
  status: DraftStatus
  createdAt: string
  updatedAt: string
  generatedFiles?: string[]
  devDependencies?: string[]
  errorMessage?: string
}

export interface DraftPrdDocument {
  filename: string
  contentType: string
  characters: number
  text?: string
  contentBase64?: string
}

export interface AuditEntry {
  ts: string
  sessionId: string | null
  clientKind: ExternalHealClientKind | null
  action: string
  args?: Record<string, unknown>
  result?: Record<string, unknown>
}

export interface AuditList {
  entries: AuditEntry[]
}
