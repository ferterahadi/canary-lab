// Type definitions for the canary-lab web UI. Mirrors the server-side return
// shapes in apps/web-server/lib/{run-store,feature-loader,journal-store}.ts.
// Run-state primitives are shared with the server so recovery behavior has one
// semantic model; feature/journal/wizard shapes remain web-local API mirrors.
import type {
  DisplayStatus,
  HealEnd,
  RunBootFailure,
  RunFixCapture,
  RunProposedPr,
  RunLifecycleEvent,
  RunLifecycleSnapshot,
  RunStatus,
  ServiceStatus,
} from '@shared/run-state'
import type {
  ExecutionType,
  VerificationConfig,
  VerificationDiagnostics,
  VerificationRunMetadata,
  VerificationTarget,
} from '@shared/verification'
import type { RunProducer } from '@shared/run-mode'
import type {
  FlightPauseReason,
  FlightStageKey,
  FlightStatus,
} from '@shared/flights/types'
import type { ExternalHealClientKind } from './types-runs'

export type { CleanupListing, CleanupOrphan, CleanupRunEntry, CleanupWorktree, PortifyCleanupEntry, PortifyCleanupListing } from './types-cleanup'
export type { ExternalHealClientKind, ExternalHealSession, ExternalHealSessionStatus, JournalEntry, PlaywrightArtifact, PlaywrightArtifactGroup, PlaywrightArtifactKind, PlaywrightArtifactPolicy, PlaywrightPlaybackEvent, PlaywrightRetainedArtifactMode, PlaywrightScreenshotMode, RepoBranchSnapshot, RunDetail, RunIndexEntry, RunManifest, RunSummary, RunSummaryFailedEntry, RunSummaryRunningStep, ServiceManifestEntry } from './types-runs'
export type { AuditEntry, AuditList, CreateDraftPayload, CreateDraftResponse, DraftPrdDocument, DraftRecord, DraftRepo, DraftSource, DraftStatus, ExternalDraftStage, PlanStep } from './types-wizard'

export type {
  DisplayStatus,
  HealEnd,
  RunBootFailure,
  RunFixCapture,
  RunFixCaptureRepo,
  RunProposedPr,
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
} from '@shared/run-state'

export type {
  ExecutionType,
  VerificationConfig,
  VerificationDiagnostics,
  VerificationRunMetadata,
  VerificationTarget,
} from '@shared/verification'

export interface FeatureRepo {
  name: string
  localPath: string
  branch?: string
}

export interface DirtySpecSummary {
  file: string
  affectedTests: string[]
}

export interface FeatureDirtyState {
  status: 'clean' | 'dirty'
  /** Modified spec files (relative to the feature dir), with their test titles.
   *  Only populated when status is 'dirty'. */
  specs: DirtySpecSummary[]
}

/** Client-only placeholder marker — the server NEVER sets this. Present when a
 *  ledger row stands in for a First-Flight batch flight that hasn't scaffolded
 *  its `feature.config.cjs` yet: the flight record exists (queued/running) but
 *  the feature is not on disk. The ledger renders such a row muted, cog-less,
 *  and clicking it opens the flight. Synthesized by `derivePendingFeatures`;
 *  replaced by the real feature (dedup by name) once scaffold writes the config
 *  and the `feature-created` event refetches the list. */
export interface FeaturePending {
  flightId: string
  status: FlightStatus
  currentStage: FlightStageKey | null
  pauseReason?: FlightPauseReason
}

/** Server-derived on-disk stage artifacts (see web-server stage-evidence.ts —
 *  the shape must match what /api/features emits). */
export interface FeatureStageEvidence {
  /** A captured envset exists (env-capture stage artifact). */
  envCapture: boolean
  /** docs/_prd-summary.json exists (prd-summary stage artifact). */
  prdSummary: boolean
  /** At least one authored spec under e2e/ (specs-coverage stage artifact). */
  specs: boolean
}

export interface Feature {
  name: string
  description?: string
  /** Set only on synthesized placeholder rows — see FeaturePending. Absent on
   *  every real feature the server returns. */
  pending?: FeaturePending
  /** Optional grouping label — features sharing a group render under one
   *  section in the UI. Absent when the feature declares no group. */
  group?: string
  repos: FeatureRepo[]
  envs: string[]
  /** A saved port overlay exists (features/<feature>/portify/) → boots
   *  concurrently. Drives the "Portified" badge. Optional: absent in older
   *  payloads. */
  portified?: boolean
  /** On-disk stage artifacts — feeds the picker's evidence-derived stage rail
   *  for features with no flight record. Optional: absent in older payloads
   *  (the rail then falls back to all-pending / "not flown"). */
  evidence?: FeatureStageEvidence
  /** Test-file integrity. 'dirty' when a spec changed since the last green (or
   *  run-start) and wasn't approved/committed. Drives the red cue. Optional:
   *  absent in older payloads / when integrity tracking is off. */
  dirty?: FeatureDirtyState
}

export interface ExtractedStep {
  label: string
  line: number
  bodySource: string
  children: ExtractedStep[]
}

export interface ExtractedTest {
  id?: string
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

export type EvaluationExportMode = 'raw' | 'localized'

export type EvaluationExportStatus = 'running' | 'completed' | 'failed'

export type EvaluationExportProducer = RunProducer

export interface EvaluationExportTask {
  taskId: string
  runId: string
  feature: string
  mode: EvaluationExportMode
  producer?: EvaluationExportProducer
  status: EvaluationExportStatus
  createdAt: string
  updatedAt: string
  downloadReady: boolean
  clientKind?: ExternalHealClientKind
  sessionId?: string
  conversationName?: string
  language?: string
  externalSessionUrl?: string
  error?: string
  /** Present once the localized-rewrite agent is spawned — the export dialog
   *  renders its live AgentSessionView instead of the text progress panel.
   *  Absent for raw/external/cached runs (no live agent). */
  sessionRef?: { agent: 'claude' | 'codex'; sessionId: string }
  /** What the built archive holds, recorded when the zip was written. Absent
   *  while running, on a failed export, and on tasks exported before this was
   *  recorded — so a row shows the size it knows and omits it otherwise. */
  archive?: EvaluationArchiveContents
}

export interface EvaluationArchiveContents {
  bytes: number
  videos: number
  assets: number
}

// Requirement Coverage Ledger — the computed shapes are shared with the server.
export type {
  CoverageJobIndexEntry,
  CoverageJobKind,
  CoverageJobManifest,
  CoverageJobResult,
  CoverageJobStatus,
  CoverageLedger,
  CoverageStateView,
  CoverageStatus,
  CoverageTotals,
  DriftDetail,
  GapType,
  PathCoverage,
  PathType,
  PrdSummary,
  ProposedMapping,
  Requirement,
  RequirementCoverage,
  StrictnessTier,
  SummaryState,
  CoverageState,
  TestCoverage,
  TestStrength,
} from '@shared/coverage/types'

export interface FeatureDoc {
  relPath: string
  /** Absolute path on disk — used to open the doc in the configured editor. */
  absPath: string
  generated: boolean
  sizeBytes: number
  /** A symlink to a doc that lives elsewhere (the user's original is the live
   *  source). Absent for plain files. */
  linked?: boolean
  /** The symlink's target, when linked (shown in the docs UI tooltip). */
  linkTarget?: string
  /** A symlink whose target no longer exists — surfaced, never crashed on. */
  broken?: boolean
}

export interface FeatureDocsListing {
  feature: string
  docs: FeatureDoc[]
  hasPrdSummary: boolean
  prdSummaryGeneratedAt?: string
  sourceDocCount: number
  docsDrift: boolean
}

export type UpdateJobStatus = 'running' | 'done' | 'failed' | 'aborted'

export interface UpdateJobManifest {
  jobId: string
  status: UpdateJobStatus
  targetVersion: string
  startedAt: string
  endedAt?: string
  log: string
  error?: string
}

export interface VersionStatus {
  /** The version the running server was started with. */
  current: string | null
  /** Latest published on the registry, or null if the check hasn't resolved. */
  latest: string | null
  updateAvailable: boolean
  packageName: string | null
  /** The most recent self-update job, if any. */
  update: UpdateJobManifest | null
}
