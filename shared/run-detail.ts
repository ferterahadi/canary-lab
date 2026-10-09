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
  /** Each stamped attempt's own retained media, keyed by
   *  `PlaybackEventKey.attemptKey`. Unlike `playwrightArtifacts` (the latest
   *  copy per test name), a later execution never replaces these. */
  attemptArtifacts?: Record<string, PlaywrightArtifact[]>
  /** Retained per-execution media no attempt claims. */
  unassignedArtifacts?: RunExecutionArtifact[]
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

export interface RunExecutionArtifact extends PlaywrightArtifact {
  execution: number
}

/** Where one execution's service output is kept: the immutable per-execution
 *  segment, or the live log while that execution is the latest. */
export type ServiceLogSource = 'segment' | 'live'

/** Lines `startLine`…`endLine` (1-based, inclusive) of a retained service log,
 *  between one test attempt's `<name>`…`</name>` markers. `closed: false` = the
 *  close marker never arrived (the attempt is running, or it was cut short), so
 *  the span runs to the end of the file. */
export interface ServiceLogSpan { startLine: number; endLine: number; closed: boolean }

/** A bounded, plain-text window of a retained service log. */
export interface ServiceLogWindow { firstLine: number; lines: string[]; truncated: boolean }

/** One service's output for one test attempt. `matchedBy: 'order'` = the log
 *  holds several spans under the same marker name (retries, or tests sharing
 *  a title), and this one was chosen by its position. */
export interface ServiceLogExcerpt {
  service: string
  name: string
  execution: number
  source?: ServiceLogSource
  totalLines?: number
  span?: ServiceLogSpan
  matchedBy?: 'marker' | 'order'
  window?: ServiceLogWindow
  /** Why there is no span: the execution's output was not retained, or the
   *  service printed no marker for this attempt. */
  missing?: 'not-retained' | 'no-marker'
}

export interface ServiceLogExcerpts { execution: number; excerpts: ServiceLogExcerpt[] }

/** A window of one service's retained log for the anchored full-log view. */
export interface ServiceLogLines extends ServiceLogWindow {
  service: string
  execution: number
  source: ServiceLogSource
  totalLines: number
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
  /** The cycle's input failures, by summary name (title slugs — two cases
   *  that share a title share a name). Absent when the entry lists none. */
  failingTests?: string[]
  /** Run-wide repair cycle and the execution it started from. Absent on
   *  entries written before they were stamped. */
  cycle?: number
  inputExecution?: number
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
