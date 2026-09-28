import type { DiagnosisPolicy } from '../../shared/diagnosis-policy'

export type Agent = 'codex' | 'claude'
export type Workflow = 'canary' | 'plain'
export type ScenarioId = 'single-service' | 'cross-service'
export interface StudySelection { agent: Agent; scenario?: ScenarioId }
export interface StudyVariant { id: string; diagnosisPolicy: DiagnosisPolicy }
export interface StudyDesign { mode: 'live' | 'replay'; repetitions: number; seed: number; variants?: StudyVariant[] }
export interface Telemetry {
  status: 'observed' | 'unavailable' | 'not-applicable'
  requestEvents: number | null
  errorEvents: number | null
  retryEvents: number | null
  requestDurationMs: number | null
  streamDurationMs: number | null
  toolDurationMs: number | null
  rejectedBatches: number
}
export type Outcome = 'success' | 'failed' | 'timeout' | 'interrupted' | 'infrastructure-error' | 'contaminated'

export interface ModelPin { model: string; effort: string; version: string; executable?: string }
export interface Attempt {
  id: string
  agent: Agent
  workflow: Workflow
  scenario: ScenarioId
  repetition: number
  variant?: StudyVariant
}
export interface Usage {
  input: number
  output: number
  cacheRead: number | null
  cacheWrite: number | null
}
export interface AttemptResult extends Attempt {
  outcome: Outcome
  startedAt: string
  repairMs: number | null
  verificationMs: number
  usage: Usage | null
  telemetry?: Telemetry
  attribution?: UsageAttribution
  adherence?: PolicyAdherence
  timing?: AttemptTiming
  testExecutions: number | null
  humanInterventions: number
  changedFiles: string[]
  reason: string
  evidence: string
}
export interface StudyManifest {
  schemaVersion: 1
  status: 'preparing' | 'ready' | 'running' | 'complete'
  createdAt: string
  root: string
  sourceWorkspace: string
  sourceRevision: string
  sourceDigest: string
  dependencyDigest: string
  dependencyVersions: Record<string, string>
  pins: Record<Agent, ModelPin>
  codexToolArgs?: string[]
  budgetMs: number
  preparationMs: number
  preparation: Record<string, unknown>
  snapshots: Record<ScenarioId, string>
  frozenDigest: string
  attempts: Attempt[]
  selection?: StudySelection
  design?: StudyDesign
  experiment?: { configurationDigest: string; promptDigests: Record<string, string>; maxTokens: number }
  stopReason?: string
  results: AttemptResult[]
  active: { attempt: Attempt; startedAt: string } | null
}
export interface ExecutionResult {
  status: 'finished' | 'timeout' | 'interrupted' | 'infrastructure-error'
  reason: string
  usage: Usage | null
  telemetry?: Telemetry
  attribution?: UsageAttribution
  adherence?: PolicyAdherence
  testExecutions: number | null
}

export type SessionRole = 'primary' | 'diagnosis-child' | 'approval-review' | 'unknown'
export interface AttributedSession {
  sessionId: string
  parentSessionId: string | null
  role: SessionRole
  evidence: string
  usage: Usage | null
  startedAt: string | null
  endedAt: string | null
}
export interface UsageAttribution {
  sessions: AttributedSession[]
  missingSessions: string[]
  issues: string[]
  total: Usage | null
  byRole: Record<SessionRole, Usage | null>
}
export interface PolicyAdherence {
  assigned: DiagnosisPolicy
  status: 'unknown' | 'violation'
  childCount: number
  evidence: string[]
  /** Semantic grouping and escalation require transcript review, never agent self-certification. */
  reviewRequired: true
}
export interface AttemptTiming {
  dispatchedAt: string
  workerReturnedAt: string | null
  evaluatorStartedAt: string | null
  evaluatorCompletedAt: string | null
  independentVerdictMs: number | null
  elapsedMs: number
}
