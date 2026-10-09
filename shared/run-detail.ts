import type { PlaybackIdentity } from './playback-identity'
import type { PlaywrightPlaybackEvent, RunSummaryRunningStep } from './playback'
export type { PlaywrightPlaybackEvent, RunSummaryRunningStep } from './playback'
// What GET /api/runs/:id returns: the manifest plus the reporter's summary,
// playback events and artifacts. Shared so the web UI reads the server's own
// declaration instead of a mirror.
import type { PathType } from './coverage/types'
import type { EnvironmentExclusion } from './run-applicability'
import type { RunManifest } from './run-manifest'
import type { RunIndexEntry } from './run-index'
import type { RunLifecycleEvent } from './run-state'

export interface RunSummaryFailedEntry {
  id?: string
  name: string
  error?: { message: string; snippet?: string }
  durationMs?: number
  location?: string
  /** Every frame of the failing step's location chain, innermost first. The
   *  reporter writes this whenever the failure came from a step (see
   *  `summary-reporter.ts`), and the UI prefers it over `location` to point at
   *  the helper that actually threw. Declared here because it is on the wire:
   *  the web mirror has always read it, while this read-side projection omitted
   *  it — a one-directional gap that nothing could catch until `check:wire`. */
  locations?: string[]
  retry?: number
  logFiles?: string[]
  /** Repo-relative path to `failed/<slug>/error.txt` — the full, untruncated
   *  error message + code-frame written by log enrichment. Persisted in the
   *  summary JSON; surfaced as `errorPath` in the heal pointer bundle. */
  errorFile?: string
  /** Repo-relative path to the curated `failure-summary.md` extracted from this
   *  test's Playwright trace.zip. Written by `summary-reporter.ts` in onEnd.
   *
   *  Declared here because readers need it: `coverage/logic/verification.ts`
   *  reaches for it and, while this field was missing, could only do so through
   *  an `as RunSummaryFailedEntry & { traceSummaryFile?: string }` widening cast
   *  at both call sites. A cast is not a type — it silences the mismatch instead
   *  of recording it, so the read shape drifted from what the reporter actually
   *  persists without anything failing.
   *
   *  The producer of record for the on-disk `e2e-summary.json` entry is
   *  `TestEntry` in `runtime/summary-types.ts`; this interface is the read-side
   *  projection of it and must only ever be a subset. */
  traceSummaryFile?: string
}

export interface RunSummary {
  environment?: string
  environmentExclusions?: EnvironmentExclusion[]
  complete: boolean
  total: number
  passed: number
  /** Names of tests that have actually passed. Distinct from `passed` (count)
   *  so the UI can mark only-run tests as passed without falsely turning
   *  unrun tests green when the suite stops early (pause / max-failures). */
  passedNames?: string[]
  passedIds?: string[]
  /** Names of tests Playwright reported as skipped. Kept separate from
   *  `failed` so the UI and heal loop do not treat skipped tests as failures. */
  skipped?: number
  skippedNames?: string[]
  skippedIds?: string[]
  /** The summary was seeded from a prior execution (a targeted heal rerun
   *  merged untouched results forward), so its outcomes span several partial
   *  executions rather than one clean run. Written by the reporter; read by the
   *  certificate and the coverage ledger's proven axis. */
  mergedFromPriorExecution?: boolean
  knownTests?: Array<{
    id?: string
    name: string
    title?: string
    titlePath?: string[]
    location?: string
    // Verified-coverage linkage. Optional / forward-compat: the Playwright
    // reporter (a subprocess) builds knownTests from TestCase objects and does
    // not parse comment annotations, so these are normally resolved at coverage-
    // computation time by joining test identity (name + location) against the
    // current spec's `@requirement`/`@path` annotations. Kept on the type so the
    // join result can be attached and a future reporter could stamp them.
    requirements?: string[]
    pathTypes?: PathType[]
  }>
  /** Currently-running Playwright test, emitted by the reporter on
   *  onTestBegin. Cleared when the matching onTestEnd lands. */
  running?: { id?: string; name: string; location: string; step?: RunSummaryRunningStep }
  /** All currently-running Playwright tests. Present when Playwright workers
   *  run multiple test cases concurrently. */
  runningTests?: Array<{ id?: string; name: string; location: string; step?: RunSummaryRunningStep }>
  failed: RunSummaryFailedEntry[]
}

export interface RunDetail {
  runId: string
  manifest: RunManifest
  /** Read-side recovery hint for runs recorded before singleAttempt existed. */
  newRunRequired?: true
  summary?: RunSummary
  playbackEvents?: PlaywrightPlaybackEvent[]
  playbackIdentity?: PlaybackIdentity
  playwrightArtifacts?: PlaywrightArtifactGroup[]
  lifecycleEvents?: RunLifecycleEvent[]
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

// Pure-ish business logic for the journal viewer. The Fastify route layer
// owns the request shape; this module owns the markdown parsing and filtering.

export interface JournalSection {
  iteration: number | null
  timestamp: string | null
  feature: string | null
  run: string | null
  outcome: string | null
  hypothesis: string | null
  body: string
}

// `/ws/runs` frames. Stable: the web client treats unknown `type` values as
// no-ops, so adding fields is non-breaking; renaming a frame type IS
// breaking. Keep additive.
export type RunsStreamFrame =
  /** Sent once when the connection opens. Carries everything the client
   *  needs to render its initial UI without making any HTTP calls. */
  | { type: 'snapshot'; runs: RunIndexEntry[]; details: Record<string, RunDetail> }
  /** A single run changed (created, status flipped, finalized). The client
   *  patches `state.details[runId]` with `detail` and inserts/updates the
   *  matching `state.runs` entry. */
  | { type: 'update'; runId: string; detail: RunDetail }
  /** A run was removed from history (DELETE on a terminal run). The client
   *  drops it from both `state.runs` and `state.details`. */
  | { type: 'removed'; runId: string }
  /** A list-level change with no specific runId (today: the boot-time
   *  reaper). The client refreshes its `state.runs` snapshot from the
   *  attached payload and reconciles details for any newly-active rows
   *  via the next `update` frame. */
  | { type: 'list-changed'; runs: RunIndexEntry[] }
