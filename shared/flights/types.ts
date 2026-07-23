// Flight — shared data model.
//
// A "flight" is the conducted onboarding pipeline behind `canary-lab flight`: one
// background job that takes a bare product repo (or several) through
// similarity → scout → scaffold → env-capture → docs → prd-summary →
// specs-coverage → portify → run → heal → evaluation-export, pausing at typed
// human checkpoints. The conductor is a deterministic server-side stage
// machine; agents are spawned per-stage for judgment work only, and every
// stage verdict is computed by the harness (see docs/PRD.md's trust posture —
// a stage never "succeeds" on agent say-so).
//
// These types are consumed by the web-server (conductor + MCP) and the web UI
// (Flights pill + flight detail view), so they live in `shared/`.

/** Stage keys, in binding execution order. */
export const FLIGHT_STAGE_KEYS = [
  'similarity',
  'scout',
  'scaffold',
  'env-capture',
  'docs',
  'prd-summary',
  'specs-coverage',
  'portify',
  'run',
  'heal',
  'evaluation-export',
] as const

export type FlightStageKey = (typeof FLIGHT_STAGE_KEYS)[number]

export type FlightStageStatus =
  | 'pending'
  | 'running'
  | 'waiting-for-approval'
  | 'done'
  | 'failed'
  | 'skipped'

/** The typed human checkpoints a flight can pause on. Everything else is
 *  autonomous; `--yolo` skips all of these except `missing-env`. */
export type FlightCheckpointKind =
  | 'similarity-choice' // existing feature matches the target repos → rerun / enhance / new
  | 'config-approval'   // the scaffolded feature.config.cjs, before the first boot
  | 'missing-env'       // env capture found keys it cannot source (never skipped)
  | 'prd-source'        // docs stage: add/confirm requirement docs before the PRD summary
  | 'coverage-stuck'    // specs↔coverage loop hit its bound with gaps left
  | 'portify-gate'      // before the portify agent starts: run parallel readiness, or skip (stay serial)
  | 'portify-apply'     // portify agent proposes edits; approve before apply
  | 'run-failed'        // run ended failed/aborted after heal → rerun or export as-is
  | 'export-mode'       // pick the evaluation flavor before exporting: raw | localized

export interface FlightCheckpoint {
  kind: FlightCheckpointKind
  /** Human-readable question shown in the UI / CLI / MCP result. */
  message: string
  /** Closed choice set when the checkpoint is a pick (e.g. rerun/enhance/new). */
  options?: string[]
  /** Checkpoint payload — draft config source, missing key list, open gaps, … */
  data?: unknown
}

/** Outcome of the collector agent's previous attempt, carried on the
 *  `prd-source` checkpoint's `data`. Structured rather than folded into
 *  `message` so the UI can give the verdict its own row AND stop recommending
 *  the path that just came back empty — a prose sentence can do neither. */
export interface PrdSourceAttempt {
  mode: 'collect-repo-docs' | 'infer-from-diff'
  /** `empty` = the agent ran and found nothing; `no-output` = it produced no
   *  doc without saying why; `no-diff` = there was nothing to infer from. */
  outcome: 'empty' | 'no-output' | 'no-diff'
  /** The agent's own one-line reason, verbatim and unpunctuated by us. */
  reason?: string
}

/** `data` payload of the `prd-source` checkpoint. */
export interface PrdSourceCheckpointData {
  docs: string[]
  linked: string[]
  intent: string
  lastAttempt?: PrdSourceAttempt
}

/** The client's answer to a checkpoint. `choice` addresses `options`; `values`
 *  carries user-supplied env values for `missing-env`. */
export interface FlightCheckpointResponse {
  choice?: string
  values?: Record<string, string>
  data?: unknown
  /** The user's "what went wrong last time" note — appended to the prompt of
   *  the agent the responded choice spawns (R74: feedback-on-redo channel). */
  feedback?: string
}

/** Structured evidence behind a stage `error` when a boot-verify service
 *  failed — the verdict distinguishes a crash from an unhealthy service, and
 *  the log tail puts the actual cause on the stage instead of a bare verdict
 *  line the user has to go digging for. */
export interface FlightStageErrorDetail {
  service: string
  /** From the run's bootFailure: `process-exited` = crashed before healthy;
   *  `health-timeout` = up but never answered its readiness probe. */
  reason: 'process-exited' | 'health-timeout'
  logPath: string
  /** Last lines of the service log at failure time. */
  logTail: string
}

/** A machine-actionable fix for a failed stage, derived at READ time from the
 *  stage's error signature plus a live `git status` re-check of the flight's
 *  repos — never persisted, so repos the user cleans by hand drop off on the
 *  next read and an empty list means "just Continue". Served by
 *  GET /api/flights/:id/remedy and attached to failed stage rows in the MCP
 *  get_flight view; POST /api/flights/:id/remedy executes it. */
export interface FlightStageRemedy {
  kind: 'dirty-repos'
  /** The failed stage this remedy unblocks. */
  stage: FlightStageKey
  /** Repos still dirty right now (path is the resolved realpath; modified is
   *  the `git status --porcelain` line count). */
  repos: Array<{ name: string; path: string; modified: number }>
  /** Server-executable fixes: `stash` = `git stash push -u` per dirty repo
   *  (undoable via `git stash pop`); `commit` = `git add -A` + commit
   *  "canary-lab: wip". Both then resume the flight. */
  actions: Array<'stash' | 'commit'>
}

export interface FlightStage {
  key: FlightStageKey
  status: FlightStageStatus
  startedAt?: string
  endedAt?: string
  /** Harness-computed proof the stage settled on (boot summary, coverage
   *  ledger snapshot, archive path…) — never agent-asserted. */
  evidence?: unknown
  /** Structured LIVE progress while the stage runs (kept after it settles as
   *  the audit trail). Shape is stage-specific — specs-coverage publishes
   *  `SpecsCoverageProgress` so the UI can render the authoring↔mapping loop
   *  instead of parsing log text. */
  progress?: unknown
  /** Present while status is `waiting-for-approval`. */
  checkpoint?: FlightCheckpoint
  /** The response that released the checkpoint (kept for the audit trail). */
  checkpointResponse?: FlightCheckpointResponse
  error?: string
  /** Structured boot-failure evidence accompanying `error` (log tail + path). */
  errorDetail?: FlightStageErrorDetail
  /** Appended progress log for display (mirrors coverage-job manifests). */
  log?: string
  /** Why the stage was skipped (similarity jump, already portified, …). */
  skipReason?: string
}

export type FlightStatus =
  | 'running'
  | 'waiting-for-approval'
  /** Resumable stop: a stage failed, the server restarted mid-stage, or the
   *  user paused it. `flight` again (or the resume endpoint) picks up from the
   *  first open stage. `FlightManifest.pauseReason` says which it was. */
  | 'paused'
  | 'done'
  | 'failed'
  | 'aborted'

/** Why a flight is `paused` — drives the UI copy ("paused by you" vs "stage
 *  failed") and keeps a user pause from reading as an error. Absent on
 *  pre-existing manifests (legacy = stage-failed/restart semantics).
 *  `queued` = parked by the plan-features launch waiting for the repo's active
 *  flight to settle — auto-started by the conductor's queue drain, never an
 *  attention state. */
export type FlightPauseReason = 'user' | 'stage-failed' | 'restart' | 'queued'

export interface FlightOptions {
  /** Envset name the flight captures into / runs against. */
  env: string
  /** Coverage the specs↔coverage loop must reach before advancing (0–100). */
  coverageTarget: number
  /** R79: which CLI conducts this flight's stage agents (scout, requirements
   *  collector, PRD summary, spec author, coverage mapper). Chosen at start
   *  (defaulting from the workspace's default-agent setting) and STICKY for
   *  the record's lifetime: jump/continue reuse the stored value; only a full
   *  redo may change it. Absent → claude. */
  agent?: 'claude' | 'codex'
  /** Base branch for diff-inferred requirements (auto-detected when absent). */
  base?: string
  /** Skip every checkpoint except missing-env. */
  yolo: boolean
  /** R71/W4 autopilot: checkpoints with a safe default answer themselves
   *  (config-approval→approve, prd-source→continue when docs exist,
   *  coverage-stuck→accept-partial, portify-apply→apply,
   *  run-failed→export-as-is, export-mode→raw); similarity-choice and
   *  missing-env always park. Absent = ON (default for new flights); set
   *  `false` to be asked at every checkpoint. Milder than yolo: every
   *  auto-answer is logged `[autopilot]` on the stage, and a re-parked
   *  checkpoint (e.g. a config parse error) is never auto-answered twice. */
  autopilot?: boolean
  /** Grouping label the scaffold writes into feature.config.cjs (`group:`) —
   *  set by the plan-features launch so sibling features render together. */
  group?: string
  /** This flight came from a confirmed plan-features proposal: the user
   *  already chose to create N distinct features over the same repo(s), so
   *  the similarity stage takes the 'new' path instead of re-asking (or
   *  yolo-rerunning the sibling that scaffolded first). */
  plannedSplit?: boolean
}

export interface FlightManifest {
  flightId: string
  /** Feature this flight targets (created by the flight, or matched by the
   *  similarity stage). */
  feature: string
  /** Resolved realpaths of the target product repos (single-flight key). */
  repoPaths: string[]
  description: string
  opts: FlightOptions
  status: FlightStatus
  /** Present while status is `paused` — see FlightPauseReason. */
  pauseReason?: FlightPauseReason
  /** The stage the conductor is at (or stopped at). Null once terminal. */
  currentStage: FlightStageKey | null
  stages: FlightStage[]
  createdAt: string
  updatedAt: string
  endedAt?: string
  error?: string
  /** Terminal status of the flight's run, once the run stage settles. */
  runVerdict?: 'passed' | 'failed' | 'aborted'
  /** The user's "what went wrong last time" note from a Continue → from-a-step
   *  re-entry (R74). Scoped to the entry stage: that stage's agent spawn
   *  appends it to its prompt; other stages ignore it. Overwritten by the next
   *  re-entry, kept afterwards as the audit trail. */
  feedback?: { stage: FlightStageKey; note: string }
  /** R78: the stage the user explicitly re-entered (Continue → "from a step…",
   *  or a redo). Autopilot does NOT auto-answer that stage's first checkpoint —
   *  choosing to re-run a step IS the intent to decide it differently, so the
   *  flight asks even when a safe default exists. Cleared the moment that stage
   *  parks or settles, so only the first checkpoint is protected. */
  askAtStage?: FlightStageKey
  /** Pointers to the flight's deliverables. */
  links?: {
    runId?: string
    evaluationTaskId?: string
    /** Absolute path of the evaluation archive — the flight's deliverable. */
    evaluationZip?: string
  }
}

export interface FlightIndexEntry {
  id: string
  createdAt: string
  flightId: string
  feature: string
  repoPaths: string[]
  /** Grouping label from the flight's options (`opts.group`) — lets the ledger
   *  and pill group a flight's still-pre-scaffold feature without fetching the
   *  full manifest. Absent when the flight declares no group. */
  group?: string
  status: FlightStatus
  /** Present while status is `paused` — lets the pill/toast tell a user pause
   *  from a stage failure without fetching the full manifest. */
  pauseReason?: FlightPauseReason
  currentStage: FlightStageKey | null
  /** Slim per-stage status summary (feeds the UI's mini progress rail). */
  stages?: Array<{ key: FlightStageKey; status: FlightStageStatus }>
  updatedAt: string
  endedAt?: string
  [key: string]: unknown
}

/** One settled pass of the specs↔coverage loop: what the pass left behind,
 *  harness-computed (the ledger after mapping, or the validation verdict that
 *  burned the pass). */
export interface SpecsCoveragePass {
  pass: number
  /** Ledger % after this pass's mapping (absent when validation burned it). */
  coveragePct?: number
  gapsOpen?: number
  /** Why the pass didn't reach mapping ('spec files rejected', 'dry-run failed'). */
  note?: string
}

/** Live shape of the specs↔coverage stage — the authoring↔mapping loop the
 *  flight view renders as a pass timeline. Published via `FlightStage.progress`
 *  on every sub-phase transition; the last snapshot survives settle. */
export interface SpecsCoverageProgress {
  pass: number
  maxPasses: number
  /** What the loop is doing RIGHT NOW inside the current pass. */
  phase: 'authoring' | 'validating' | 'mapping'
  /** Ledger % going INTO the current pass (the target drives the loop). */
  coveragePct: number
  target: number
  gapsOpen: number
  /** Settled passes, oldest first. */
  passes: SpecsCoveragePass[]
}

/** Live shape of the portify stage — published via `FlightStage.progress` the
 *  moment the background workflow exists, so the flight view can tail the
 *  workflow's agent session while the agent is still editing (the longest
 *  phase), and a stage parked mid-step can still drill through to it.
 *  `evidence` carries the same id only once the stage settles. The phase mirror fields
 *  are republished only when they change (the stage polls every 3s — a
 *  manifest write per poll would be churn): the flight view derives its
 *  attempt stepper + phase verb from them, and its embedded portify timeline
 *  from the workflowId. */
export interface PortifyStageProgress {
  workflowId: string
  /** The workflow's live phase (planning / editing / verifying / ready-to-save). */
  status?: string
  /** Agent attempt counter from the workflow manifest (1-based). */
  attempt?: number
  maxAttempts?: number
}

/** One row of the stage-entry menu: can a flight start AT this stage right
 *  now, and if not, which prerequisite is missing (the validator's message). */
export interface FlightStageEntryOption {
  key: FlightStageKey
  allowed: boolean
  reason?: string
}

/** GET /api/flights/entry — what the UI needs to offer "flight this feature
 *  from stage X": the latest flight record (attach/continue targets),
 *  per-stage entry verdicts computed by the SAME validator the start path
 *  enforces (no client-side prereq duplication), and the start-form prefill. */
export interface FlightEntryOptions {
  feature: string
  flight: {
    flightId: string
    status: FlightStatus
    stages: Array<{ key: FlightStageKey; status: FlightStageStatus }>
  } | null
  /** True → the flight is running/waiting now; open it instead of starting. */
  active: boolean
  /** True → mode "continue" is available (paused flight, first open stage). */
  canContinue: boolean
  prefill: { repoPaths: string[]; description: string; env: string; coverageTarget: number }
  stages: FlightStageEntryOption[]
}

/** Flight statuses that hold the single-flight lock for their repo set. */
export const ACTIVE_FLIGHT_STATUSES: readonly FlightStatus[] = [
  'running',
  'waiting-for-approval',
]

export function isActiveFlightStatus(status: FlightStatus): boolean {
  return ACTIVE_FLIGHT_STATUSES.includes(status)
}

export function isTerminalFlightStatus(status: FlightStatus): boolean {
  return status === 'done' || status === 'failed' || status === 'aborted'
}

/** One feature the plan-features agent proposes for a broad intent. `name` is
 *  a slug (deriveFeatureSlug alphabet); `description` becomes that flight's
 *  intent; `scope` is the one-line rationale shown on the proposal card. */
export interface PlannedFeature {
  name: string
  description: string
  scope?: string
  /** Shared grouping label for sibling features split from one intent. */
  group?: string
}

/** The plan-features agent's judgment: does the intent describe one coherent
 *  feature or several? `features` always has ≥1 entry (split=false → exactly
 *  one, carrying a properly named single feature). */
export interface PlanFeaturesResult {
  split: boolean
  features: PlannedFeature[]
}

/** `launched` = the proposal was confirmed and its flights exist — a terminal
 *  state that keeps a second launch from double-creating them. */
export type PlanFeaturesTaskStatus = 'running' | 'done' | 'failed' | 'launched'

/** File-backed record of one plan-features agent run (the pre-flight intent
 *  breakdown behind the new-flight dialog). */
export interface PlanFeaturesTask {
  taskId: string
  repoPaths: string[]
  description: string
  /** Rider from the new-flight dialog's toggle — carried so the launch (auto
   *  or proposal-confirmed) starts its flights with the user's choice. Absent
   *  = autopilot on. */
  autopilot?: boolean
  /** R79: the dialog's agent pick, carried the same way — every launched
   *  flight is conducted by this CLI. Absent = claude. */
  agent?: 'claude' | 'codex'
  status: PlanFeaturesTaskStatus
  result?: PlanFeaturesResult
  error?: string
  /** Set on a settled single-feature plan the server could NOT auto-launch
   *  because the derived name is already in use — the task stays `done` and the
   *  dialog reopens on the proposal card so the user can rename. */
  conflicts?: string[]
  /** Flights created by the launch, in queue order (first one is running). */
  launchedFlightIds?: string[]
  createdAt: string
  updatedAt: string
}

/** Feature name derived from a repo path — the ONE slug rule shared by the
 *  CLI, the MCP start_flight tool, and the new-flight dialog, so all four
 *  surfaces derive identical names (basename → lowercase → non-alphanumerics
 *  collapsed to '-'). */
export function deriveFeatureSlug(repoPath: string): string {
  const base = repoPath.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? 'feature'
  const slug = base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return slug || 'feature'
}
