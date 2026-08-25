// Type definitions for the canary-lab web UI. Mirrors the server-side return
// shapes in apps/web-server/lib/{run-store,feature-loader,journal-store}.ts.
// Run-state primitives are shared with the server so recovery behavior has one
// semantic model; feature/journal/wizard shapes remain web-local API mirrors.
import type { HealEnd, RunBootFailure, RunFixCapture, RunPrAttempt, RunProposedPr, RunLifecycleEvent, RunLifecycleSnapshot, RunStatus, ServiceStatus } from '@shared/run-state'
import type { ExecutionType, VerificationRunMetadata } from '@shared/verification'
import type { ClientKind } from '@shared/run-mode'

export interface RunIndexEntry {
  runId: string
  executionType?: ExecutionType
  feature: string
  startedAt: string
  status: RunStatus
  endedAt?: string
  /** Repair cycles this run consumed, mirrored from its manifest. Absent on
   *  pre-existing entries and on runs that never healed. */
  healCycles?: number
  /** Mirrored from the manifest so terminal external repair provenance remains
   *  available when the run detail is not part of the WebSocket snapshot. */
  healMode?: 'auto' | 'manual' | 'external'
  verificationConfigName?: string
  verificationPlaywrightEnvsetId?: string
  verificationTargetUrls?: Record<string, string>
}

export interface ServiceManifestEntry {
  repoName?: string
  name: string
  safeName: string
  command: string
  cwd: string
  logPath: string
  healthUrl?: string
  status?: ServiceStatus
  /** Per-run allocated ports keyed by declared slot name. */
  allocatedPorts?: Record<string, number>
  /** Spawn time (status → starting) and first-probe-pass time (status →
   *  ready). Both absent on runs recorded before these were stamped. */
  startingAt?: string
  readyAt?: string
}

export interface RepoBranchSnapshot {
  name: string
  path: string
  branch: string | null
  expectedBranch?: string
  detached: boolean
  dirty: boolean
}

// Imported for local use below and re-exported so existing
// `from '../api/types-runs'` imports keep working; the modes themselves live in
// one shared place because six copies had drifted.
import type {
  PlaywrightArtifactPolicy,
  PlaywrightRetainedArtifactMode,
  PlaywrightScreenshotMode,
} from '@shared/configs/playwright-modes'

export type { PlaywrightArtifactPolicy, PlaywrightRetainedArtifactMode, PlaywrightScreenshotMode }

export type ExternalHealClientKind = ClientKind

export type ExternalHealSessionStatus =
  | 'connected'
  | 'waiting'
  | 'healing'
  | 'running-tests'
  | 'paused'
  | 'disconnected'

export interface ExternalHealSession {
  sessionId: string
  clientKind: ExternalHealClientKind
  clientVersion?: string
  conversationName?: string
  /** Deep link back into the owning client. Portify renders one; heal offers a
   *  resume BUTTON instead (see ExternalAgentCard), so no view reads this today
   *  — but the server sends it, and a mirror that omits a field on the wire is
   *  a field the UI cannot reach without a cast. */
  sessionUrl?: string
  claimedAt: string
  lastHeartbeatAt: string
  status: ExternalHealSessionStatus
  cycleCount: number
}

export interface RunManifest {
  runId: string
  executionType?: ExecutionType
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
  /** Per-run git worktrees (repo name → worktree path) when isolated. */
  worktrees?: Record<string, string>
  /** Why a queued run is waiting. Present only while status === 'queued'. */
  queueReason?: 'resources' | 'repo-collision'
  playwrightArtifacts?: PlaywrightArtifactPolicy
  signalPaths?: { rerun: string; restart: string }
  healMode?: 'auto' | 'manual' | 'external'
  healAgent?: 'claude' | 'codex'
  externalHealSession?: ExternalHealSession
  lifecycle?: RunLifecycleSnapshot
  /** Set when a service failed to come up, so the run was declared failed and
   *  (if heal is configured) routed into heal with the service log as context. */
  bootFailure?: RunBootFailure
  /** Why the auto-heal loop stopped without passing. Drives the Test Run
   *  hero's "why heal stopped" line. Absent unless the run entered heal. */
  healEnd?: HealEnd
  /** The heal agent's edits captured from the per-run worktree at teardown —
   *  what the run detail's Changes tab surfaces (patch path, apply-locally, PR).
   *  A flight's Test Run stage only reports that it exists, and links here. */
  fixCapture?: RunFixCapture
  /** PRs opened from this run's captured fix, per repo — automatically when the
   *  run healed green, or on demand from the Changes tab. */
  proposedPrs?: RunProposedPr[]
  /** The last PR attempt including failures, so a captured fix with no PR can
   *  say why (gh not signed in, no push rights, patch no longer applies). */
  prAttempt?: RunPrAttempt
  verification?: VerificationRunMetadata
  /** Set when the suite was cut short rather than run to completion — the
   *  `healOnFailureThreshold` trip, a user pause, or a cancelled heal. */
  stoppedEarly?: StoppedEarlyInfo
  /** Per-cycle record of which specs the heal loop re-ran and which it kept.
   *  Written for every cycle whose fix touched files. */
  healCycleHistory?: Array<{ cycle: number; restarted: string[]; kept: string[] }>
  /** ISO timestamp refreshed every few seconds while the orchestrator is alive;
   *  compare against `Date.now()` to spot a stale or orphaned run. */
  heartbeatAt?: string
}

/** Why a run stopped before finishing its suite. */
export type StoppedEarlyReason = 'max-failures' | 'user-pause' | 'user-cancel-heal'

export interface StoppedEarlyInfo {
  reason: StoppedEarlyReason
  failuresAtStop: number
  suiteTotal: number
}

export interface RunSummaryFailedEntry {
  id?: string
  name: string
  error?: { message: string; snippet?: string }
  durationMs?: number
  location?: string
  locations?: string[]
  retry?: number
  logFiles?: string[]
  traceSummaryFile?: string
  /** Repo-relative path to `failed/<slug>/error.txt` — the full, untruncated
   *  message + code-frame. Written for the heal agent (it rides `heal-index.md`)
   *  and persisted in the summary, so it reaches the client too. */
  errorFile?: string
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
  passedIds?: string[]
  skipped?: number
  skippedNames?: string[]
  skippedIds?: string[]
  knownTests?: Array<{
    id?: string
    name: string
    title?: string
    titlePath?: string[]
    location?: string
  }>
  running?: { id?: string; name: string; location: string; step?: RunSummaryRunningStep }
  runningTests?: Array<{ id?: string; name: string; location: string; step?: RunSummaryRunningStep }>
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

export interface JournalEntry {
  iteration: number | null
  timestamp: string | null
  feature: string | null
  run: string | null
  outcome: string | null
  hypothesis: string | null
  body: string
}
