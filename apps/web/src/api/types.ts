// Type definitions for the canary-lab web UI. Mirrors the server-side return
// shapes in apps/web-server/lib/{run-store,feature-loader,journal-store}.ts.
// Run-state primitives are shared with the server so recovery behavior has one
// semantic model; feature/journal/wizard shapes remain web-local API mirrors.
import type {
  DisplayStatus,
  RunLifecycleEvent,
  RunLifecycleSnapshot,
  RunStatus,
  ServiceStatus,
} from '../../../../shared/run-state'
export type {
  DisplayStatus,
  RunLifecycleAbortReason,
  RunLifecycleEvent,
  RunLifecyclePhase,
  RunLifecycleRestartPlan,
  RunLifecycleSeverity,
  RunLifecycleSignal,
  RunLifecycleSignalStatus,
  RunLifecycleSnapshot,
  RunLifecycleTargetedRerun,
  RunStatus,
  ServiceStatus,
  TransientAction,
} from '../../../../shared/run-state'

export interface FeatureRepo {
  name: string
  localPath: string
  branch?: string
}

export interface Feature {
  name: string
  description?: string
  repos: FeatureRepo[]
  envs: string[]
}

export interface ExtractedStep {
  label: string
  line: number
  bodySource: string
  children: ExtractedStep[]
}

export interface ExtractedTest {
  name: string
  line: number
  bodySource: string
  steps: ExtractedStep[]
  // Set when the test is defined in a helper file (e.g. a factory) rather
  // than the spec file that owns it. Click-throughs in the UI prefer this
  // path so the code viewer lands at the actual definition site.
  sourceFile?: string
}

export interface FeatureSpecFile {
  file: string
  tests: ExtractedTest[]
  parseError?: string
}

export type FeatureTests = FeatureSpecFile[]

export interface RunIndexEntry {
  runId: string
  feature: string
  startedAt: string
  status: RunStatus
  endedAt?: string
}

export type EvaluationExportMode = 'raw' | 'localized'
export type EvaluationExportStatus = 'running' | 'completed' | 'failed'

export interface EvaluationExportTask {
  taskId: string
  runId: string
  feature: string
  mode: EvaluationExportMode
  status: EvaluationExportStatus
  createdAt: string
  updatedAt: string
  downloadReady: boolean
  error?: string
}

export interface ServiceManifestEntry {
  name: string
  safeName: string
  command: string
  cwd: string
  logPath: string
  healthUrl?: string
  status?: ServiceStatus
}

export interface RepoBranchSnapshot {
  name: string
  path: string
  branch: string | null
  expectedBranch?: string
  detached: boolean
  dirty: boolean
}

export type PlaywrightScreenshotMode = 'off' | 'on' | 'only-on-failure'
export type PlaywrightRetainedArtifactMode = 'off' | 'on' | 'on-first-retry' | 'retain-on-failure'

export interface PlaywrightArtifactPolicy {
  screenshot: PlaywrightScreenshotMode
  video: PlaywrightRetainedArtifactMode
  trace: PlaywrightRetainedArtifactMode
}

export interface RunManifest {
  runId: string
  feature: string
  featureDir?: string
  env?: string
  startedAt: string
  endedAt?: string
  status: RunStatus
  healCycles: number
  services: ServiceManifestEntry[]
  repoPaths?: string[]
  repoBranches?: RepoBranchSnapshot[]
  playwrightArtifacts?: PlaywrightArtifactPolicy
  signalPaths?: { rerun: string; restart: string }
  healMode?: 'auto' | 'manual'
  lifecycle?: RunLifecycleSnapshot
}

export interface RunSummaryFailedEntry {
  name: string
  error?: { message: string; snippet?: string }
  durationMs?: number
  location?: string
  locations?: string[]
  retry?: number
  logFiles?: string[]
}

export interface RunSummaryRunningStep {
  title: string
  category: string
  location?: string
  locations?: string[]
}

export interface RunSummary {
  complete: boolean
  total: number
  passed: number
  passedNames?: string[]
  skipped?: number
  skippedNames?: string[]
  running?: { name: string; location: string; step?: RunSummaryRunningStep }
  failed: RunSummaryFailedEntry[]
}

export type PlaywrightPlaybackEvent =
  | {
      type: 'test-begin'
      time: string
      test: { name: string; title: string; location: string }
    }
  | {
      type: 'step-begin' | 'step-end'
      time: string
      test: { name: string; title: string }
      step: RunSummaryRunningStep
    }
  | {
      type: 'test-end'
      time: string
      test: { name: string; title: string; location: string }
      status: string
      passed: boolean
      durationMs: number
      retry: number
      error?: { message: string; snippet?: string }
      attachments?: Array<{ name: string; contentType?: string; path?: string }>
    }

export type PlaywrightArtifactKind = 'screenshot' | 'trace' | 'video' | 'other'

export interface PlaywrightArtifact {
  name: string
  kind: PlaywrightArtifactKind
  path: string
  url: string
  contentType?: string
  sizeBytes: number
  mtimeMs: number
}

export interface PlaywrightArtifactGroup {
  testName: string
  testTitle?: string
  artifacts: PlaywrightArtifact[]
}

export interface RunDetail {
  runId: string
  manifest: RunManifest
  summary?: RunSummary
  playbackEvents?: PlaywrightPlaybackEvent[]
  playwrightArtifacts?: PlaywrightArtifactGroup[]
  lifecycleEvents?: RunLifecycleEvent[]
}

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

export interface PlanStep {
  coverageType?: string
  step: string
  actions: string[]
  expectedOutcome: string
}

export interface DraftRepo {
  name: string
  localPath: string
  branch?: string
}

export interface DraftRecord {
  draftId: string
  prdText: string
  prdDocuments: DraftPrdDocument[]
  repos: DraftRepo[]
  featureName?: string
  wizardAgent?: 'claude' | 'codex'
  activeAgentStage?: 'planning' | 'generating'
  planAgentSessionId?: string
  planAgentSessionKind?: 'claude' | 'codex'
  status: DraftStatus
  createdAt: string
  updatedAt: string
  plan?: PlanStep[]
  generatedFiles?: string[]
  devDependencies?: string[]
  errorMessage?: string
  planAgentLogTail?: string
  specAgentLogTail?: string
}

export interface DraftPrdDocument {
  filename: string
  contentType: string
  characters: number
}

export interface CreateDraftPayload {
  prdText: string
  prdDocuments?: DraftPrdDocument[]
  repos: DraftRepo[]
  featureName?: string
}

export interface CreateDraftResponse {
  draftId: string
  status: DraftStatus
}

export interface JournalEntry {
  iteration: number | null
  timestamp: string | null
  feature: string | null
  run: string | null
  outcome: string | null
  hypothesis: string | null
  body: string
}
