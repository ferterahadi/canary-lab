import type { ClientKind, RunProducer } from '../../../../../../shared/run-mode'

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

export interface DraftPrdDocument {
  filename: string
  contentType: string
  characters: number
  text?: string
  contentBase64?: string
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
  externalClientKind?: ClientKind
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
  plan?: unknown
  generatedFiles?: string[]
  devDependencies?: string[]
  errorMessage?: string
}
