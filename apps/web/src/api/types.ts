// Type definitions for the canary-lab web UI. Mirrors the server-side return
// shapes in apps/web-server/lib/{run-store,feature-loader,journal-store}.ts.
// Duplicated rather than shared to keep the frontend tsconfig simple.

export interface FeatureRepo {
  name: string
  localPath: string
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
}

export interface FeatureSpecFile {
  file: string
  tests: ExtractedTest[]
  parseError?: string
}

export type FeatureTests = FeatureSpecFile[]

export type RunStatus = 'running' | 'passed' | 'failed' | 'healing' | 'aborted'

// Transient UI-only states layered over the persisted RunStatus while an
// async action is in flight. Never written to the manifest — they exist
// purely so the row's badge can reflect the user's last click ("ABORTING")
// instead of the stale persisted value ("RUNNING") during the request
// roundtrip. Resolves back to a RunStatus once the server responds.
export type TransientAction = 'aborting' | 'deleting' | 'cancelling-heal' | 'pausing'

export type DisplayStatus = RunStatus | TransientAction

export interface RunIndexEntry {
  runId: string
  feature: string
  startedAt: string
  status: RunStatus
  endedAt?: string
}

export type ServiceStatus = 'starting' | 'ready' | 'timeout' | 'stopped'

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
}

export interface RunSummaryFailedEntry {
  name: string
  error?: { message: string; snippet?: string }
  durationMs?: number
  location?: string
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
}

export interface SkillSummary {
  id: string
  name: string
  description: string
  source: string
  path: string
}

export interface SkillRecommendation {
  skillId: string
  score: number
  matchedTerms: string[]
  reasoning: string
}

export type DraftStatus =
  | 'created'
  | 'recommending'
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
}

export interface DraftRecord {
  draftId: string
  prdText: string
  prdDocuments: DraftPrdDocument[]
  repos: DraftRepo[]
  skills: string[]
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
  skills?: string[]
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
