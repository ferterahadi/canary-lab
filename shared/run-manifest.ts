// The run manifest as it is stored on disk and sent to the web UI. One
// declaration for both sides: the web app used to hand-copy these shapes, and
// the copies drifted without either side failing to compile.
import type { StageModelChoice } from './agent-models'
import type { PlaywrightArtifactPolicy } from './configs/playwright-modes'
import type { RunDependencyProvenance } from './dependency-provenance'
import type { DiagnosisPolicy } from './diagnosis-policy'
import type { SingleAttemptPolicy } from './launcher/types'
import type { ExternalSessionMeta } from './run-mode'
import type { HealEnd, QueueReason, RunBootFailure, RunFixCapture, RunLifecycleSnapshot, RunPrAttempt, RunProposedPr, RunServiceFailure, RunStatus, ServiceStatus } from './run-state'
import type { RunTestReviewApproval, TestReviewDecision } from './test-review'
import type { ExecutionType, VerificationRunMetadata } from './verification'
import type { IntegrityHint } from './verification-strength/hints'
import type { SpecDiff } from './verification-strength/types'

/** The verification-strength differential for one dirty spec: the assertion set
 *  before the edit against the assertion set now. An advisory hint, never a gate
 *  (D13) — `weaker` and `unclassifiable` are what a reader is told about. */
export interface SpecStrength extends SpecDiff {
  /** Where the before-side content came from: the run-start copy, or the
   *  committed spec when no copy holds this file. */
  baseline: 'run-start' | 'head'
}

export interface DirtySpec {
  file: string
  affectedTests: string[]
  /** Absent when no baseline content is readable (a hash-only legacy record,
   *  an untracked file with no run-start copy) — the file is still dirty. */
  strength?: SpecStrength
}

/** A live spec that differs from the copy a run executed — an edit the run has
 *  NOT run. Run-level and strict: HEAD and approvals play no part, since a
 *  committed edit is still one the verdict never saw. */
export interface PendingSpecEdit extends DirtySpec {
  change: 'modified' | 'added' | 'deleted'
}

/** Resolved choices for the two agent spawns a run owns. Both keys are always
 *  present — an agent-default resolution is stored as `{model:null,effort:null}`
 *  rather than omitted, so a restart can tell "locked to the default" apart
 *  from "pre-2.2.0 record with no plan at all". */
export interface RunModelPlan {
  heal: StageModelChoice
  commit: StageModelChoice
}

// Per-run manifest written at start and updated at finish. Kept narrow and
// JSON-shaped so the future server can read it without parsing logs.

export interface ServiceManifestEntry {
  /** Repo identity from feature.config repos[].name. Older manifests omit it. */
  repoName?: string
  name: string
  safeName: string
  command: string
  cwd: string
  logPath: string
  healthUrl?: string
  status?: ServiceStatus
  /** Per-run allocated ports keyed by the service's declared port-slot name
   *  (feature.config startCommands[].ports[].name). Empty/omitted when the
   *  service declares no ports. The UI surfaces these so concurrent runs are
   *  distinguishable. */
  allocatedPorts?: Record<string, number>
  /** When the service was spawned (status → `starting`). */
  startingAt?: string
  /** When its readiness probe first passed (status → `ready`). Together with
   *  `startingAt` this gives per-service time-to-ready, which is what the
   *  Suite setup boot rows report. Stamped here rather than derived from the
   *  run's own start/end, which also spans queue wait and teardown. */
  readyAt?: string
}

export interface RepoBranchSnapshot {
  name: string
  path: string
  branch: string | null
  expectedBranch?: string
  detached: boolean
  dirty: boolean
  /** Commit the checkout sat on when the run launched — what the run booted.
   *  Absent on records written before it was recorded; null on an unborn branch. */
  sha?: string | null
  /** Set when run start fast-forwarded the checkout to its upstream first. */
  updatedFromUpstream?: { upstream: string; from: string; to: string }
}

// Mid-Run Heal: populated when Playwright was halted before completing the
// suite — either by `--max-failures=<N>` (auto-fast-fail) or by an explicit
// user-invoked Pause & Heal. Heal-index rendering uses this so the agent
// doesn't assume the suite size from the partial summary.
export type StoppedEarlyReason = 'max-failures' | 'user-pause' | 'user-cancel-heal'

export interface StoppedEarlyInfo {
  reason: StoppedEarlyReason
  failuresAtStop: number
  suiteTotal: number
}

/** Whether this run executes a run-start copy of its suite (D9). `taken` names
 *  the copy and a digest of the spec content it held; `unavailable` means the
 *  copy failed and the run fell back to the live feature dir — said out loud so
 *  no surface claims a boundary that was never there. */
export type RunSuiteSnapshot =
  | { kind: 'taken'; dir: string; takenAt: string; digest: string; specInventoryVersion?: 1 | 2 }
  | { kind: 'unavailable'; at: string; reason: string }

/** Who took a live spec edit into the run. `human`: the adopt route in Canary
 *  Lab. `test-heal`: the runner itself, only for a run with zero editable repos
 *  — there the spec is the only fixable code and Canary told the agent to edit
 *  it, so its own signal is the adopt. Never a verdict, never an MCP tool. */
export type SpecEditsAdoptedBy = 'human' | 'test-heal'

/** Live spec edits measured against the run-start copy. `pending` is what the
 *  run has NOT executed; adopting an edit re-takes the snapshot and appends to
 *  `adopted`. Re-checked after every Playwright exit, and whenever a live spec
 *  of the feature changes while the run is waiting between executions. */
export interface RunSpecEdits {
  checkedAt: string
  pending: PendingSpecEdit[]
  adopted: Array<{ at: string; by: SpecEditsAdoptedBy; files: string[]; reviewRevision?: string }>
  reviewDecisions?: TestReviewDecision[]
}

/** What the strength differential says about `specEdits.pending` (D13).
 *  Advisory: a hint informs whoever reads the run, it never changes a status.
 *  `disclosure` travels with the hints so no surface quotes the detection
 *  without saying how it was checked. */
export interface RunIntegrity {
  hints: IntegrityHint[]
  disclosure: string
}

export type LocalHealAgent = 'claude' | 'codex'

export type ExternalHealSessionStatus =
  | 'connected'
  | 'waiting'
  | 'healing'
  | 'running-tests'
  | 'paused'
  | 'disconnected'

/**
 * Identity + liveness record for an external AI client (Claude Desktop, Codex
 * CLI, etc.) that has claimed heal duty for this run via MCP. Populated only
 * when `healMode === 'external'`. The orchestrator no longer spawns a heal
 * agent PTY in that mode — it parks at `waiting-for-signal` and lets the
 * external client write signals through `POST /api/runs/:runId/signal`.
 */
export interface ExternalHealSession extends ExternalSessionMeta {
  clientVersion?: string
  claimedAt: string
  lastHeartbeatAt: string
  status: ExternalHealSessionStatus
  cycleCount: number
}

export interface RunManifest {
  /** Frozen explicit policy; absent means the production default (`DEFAULT_DIAGNOSIS_POLICY`). */
  diagnosisPolicy?: DiagnosisPolicy
  runId: string
  executionType?: ExecutionType
  feature: string
  featureDir?: string
  env?: string
  startedAt: string
  endedAt?: string
  status: RunStatus
  healCycles: number
  /** Playwright invocations so far — the last issued `RunExecutionRef.index`.
   *  Absent on runs recorded before executions were numbered. */
  playwrightExecutions?: number
  services: ServiceManifestEntry[]
  repoPaths?: string[]
  repoBranches?: RepoBranchSnapshot[]
  /** Dependency paths and compatibility evidence captured before service boot. */
  dependencyProvenance?: RunDependencyProvenance[]
  /** When this run isolated one or more repos in a per-run git worktree
   *  (opted in after a same-repo collision), maps repo name → worktree path.
   *  Omitted/empty when the run uses repos in place. */
  worktrees?: Record<string, string>
  /** Set only while `status === 'queued'`. Explains why the run is parked so
   *  the UI can show "waiting for resources" vs "waiting for <feature> to
   *  finish". Cleared when the run is admitted. */
  queueReason?: QueueReason
  playwrightArtifacts?: PlaywrightArtifactPolicy
  stoppedEarly?: StoppedEarlyInfo
  /** The run-start suite copy the verdict rests on. Absent on runs recorded
   *  before the snapshot boundary existed and on boot-only sessions. */
  suiteSnapshot?: RunSuiteSnapshot
  /** Absent until the first Playwright exit, and on runs without a snapshot —
   *  no copy means no boundary to measure against, and `pending: []` would
   *  then read as "no edits" when the truth is "cannot tell". */
  specEdits?: RunSpecEdits
  /** A terminal run approved this exact suite revision for this new run. The
   * approval is provenance only; the new run still needs its own verdict. */
  testReviewApproval?: RunTestReviewApproval
  /** Written together with `specEdits`; same absence rule. */
  integrity?: RunIntegrity
  /**
   * Per heal-cycle record of which services were restarted vs kept warm.
   * Populated when the orchestrator processes a `.restart` signal whose body
   * carries a non-empty `filesChanged`. The heal-index footer surfaces the
   * most recent entry to the next agent invocation.
   */
  healCycleHistory?: Array<{ cycle: number; restarted: string[]; kept: string[] }>
  /** ISO timestamp updated every few seconds while the orchestrator is alive.
   *  Consumers compare against `Date.now()` to detect stale/orphaned runs. */
  heartbeatAt?: string
  /** Per-run signal file paths surfaced to the UI so the manual heal banner
   *  can show the user exactly where to write `.rerun` / `.restart`. */
  signalPaths?: { rerun: string; restart: string }
  /** When the run is heal-paused under manual mode, the UI renders a banner
   *  pointing the user at the signal paths above. Only set during the heal
   *  phase of a manual run; cleared when the run leaves the heal state.
   *
   *  `'external'` means an external AI client (Claude/Codex CLI or Desktop,
   *  connected via MCP) owns the heal loop for this run. See
   *  `externalHealSession` below for identity + heartbeat state. */
  healMode?: 'auto' | 'manual' | 'external'
  /** Resolved local CLI used for auto-heal. Locks the run to the agent that
   *  was chosen when the run started, even if project settings change later. */
  healAgent?: LocalHealAgent
  /** Model+effort plan for the run's own agent spawns (heal REPL, commit
   *  message), resolved at launch for `healAgent` and locked like it — restart
   *  reuses this instead of re-reading config. Absent on pre-2.2.0 records and
   *  on runs that never chose a local agent (external / manual / boot). */
  models?: RunModelPlan
  /** Populated when `healMode === 'external'`. Tracks the single external
   *  client that holds the heal claim for this run. */
  externalHealSession?: ExternalHealSession
  /** Latest structured lifecycle state. This is the UI source of truth for
   *  recovery flow narration; runner.log remains the human-readable audit. */
  lifecycle?: RunLifecycleSnapshot
  /** Set when a service failed to come up on a normal run, so the run was
   *  declared `failed` and (if heal is configured) routed into heal with the
   *  service log as context. Absent on healthy/boot-only runs; cleared on a
   *  successful reboot during a heal cycle. */
  bootFailure?: RunBootFailure
  /** Confirmed failure of a service after readiness, independent of test counts. */
  serviceFailure?: RunServiceFailure
  /** Why the auto-heal loop stopped without passing. Written at every give-up
   *  site in `runAutoHealLoop`; absent on passing/boot-only/manual runs and on
   *  runs that never entered heal. */
  healEnd?: HealEnd
  /** Pinned at run start so a suite config edit cannot change retry safety
   *  for an attempt that has already begun. The receipt belongs to the suite. */
  singleAttempt?: SingleAttemptPolicy
  /** The heal agent's edits from the per-run worktree. Provisional while the
   *  run is active; final capture is written at teardown. */
  fixCapture?: RunFixCapture
  /** PRs opened from this run's captured fix, per repo — by the user's own
   *  request, or automatically when the run healed green. */
  proposedPrs?: RunProposedPr[]
  /** The last PR attempt including its failures, so a run that captured a fix
   *  but opened nothing can say why. */
  prAttempt?: RunPrAttempt
  verification?: VerificationRunMetadata
}
