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
  steps: ExtractedStep[]
}

export interface FeatureSpecFile {
  file: string
  tests: ExtractedTest[]
  parseError?: string
}

export type FeatureTests = FeatureSpecFile[]

export type RunStatus = 'running' | 'passed' | 'failed' | 'healing' | 'aborted'

export interface RunIndexEntry {
  runId: string
  feature: string
  startedAt: string
  status: RunStatus
  endedAt?: string
}

export interface ServiceManifestEntry {
  name: string
  safeName: string
  command: string
  cwd: string
  logPath: string
  healthUrl?: string
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
}

export interface RunSummaryFailedEntry {
  name: string
  error?: { message: string; snippet?: string }
  durationMs?: number
  location?: string
  retry?: number
  logFiles?: string[]
}

export interface RunSummary {
  complete: boolean
  total: number
  passed: number
  failed: RunSummaryFailedEntry[]
}

export interface RunDetail {
  runId: string
  manifest: RunManifest
  summary?: RunSummary
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
