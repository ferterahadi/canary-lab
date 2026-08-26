// Flight — shared data model.
//
// A "flight" is the conducted onboarding pipeline behind `canary-lab flight`: one
// background job that takes a bare product repo (or several) through
// similarity → scout → scaffold → env-capture → docs → prd-summary →
// specs-coverage → run → heal → evaluation-export → portify, pausing at typed
// human checkpoints. The conductor is a deterministic server-side stage
// machine; agents are spawned per-stage for judgment work only, and every
// stage verdict is computed by the harness (see docs/PRD.md's trust posture —
// a stage never "succeeds" on agent say-so).
//
// These types are consumed by the web-server (conductor + MCP) and the web UI
// (Flights pill + flight detail view), so they live in `shared/`.

/** Canonical stage-record order. This stays stable for persisted manifests and
 *  restart/jump semantics; normal drive priority lives in
 *  `FLIGHT_EXECUTION_ORDER` below. */
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

/** Normal conductor priority once the current/re-entered stage has settled.
 *
 *  Parallel setup is independent of the serial Test run and the Report. The
 *  report therefore becomes available first; a large app can finish or retry
 *  its 30–60 minute port-injection pass afterward without discarding that
 *  evidence. The stable record order above deliberately remains unchanged for
 *  persisted manifests; the restart helpers give independent Parallel setup
 *  its own artifact boundary. */
export const FLIGHT_EXECUTION_ORDER = [
  'similarity',
  'scout',
  'scaffold',
  'env-capture',
  'docs',
  'prd-summary',
  'specs-coverage',
  'run',
  'heal',
  'evaluation-export',
  'portify',
] as const satisfies readonly FlightStageKey[]

/** Which stages produce the artifacts a stage actually READS — the real
 *  dependency graph, not the list order.
 *
 *  Execution order and dependency are different things, and conflating them was
 *  a bug: a positional "everything to my left must exist" rule blocked
 *  `portify`, `run` and `evaluation-export` on a PRD summary that none of them
 *  ever opens, so a suite with a green run but no requirements could not be
 *  re-entered at any of them. Declared here, in shared, because both the
 *  server's stage-entry validator and the client's "what is this step waiting
 *  on" copy must answer from the same graph.
 *
 *  Read as: to enter at KEY, the listed stages' artifacts must be on disk.
 *  - `docs` / `prd-summary` need only the suite to exist; neither boots anything,
 *    and `prd-summary`'s own checkpoint handles the no-docs case by collecting or
 *    inferring, so a source doc is not an entry prerequisite.
 *  - `specs-coverage` genuinely needs the PRD summary — it maps specs onto
 *    requirements — and the envset, because its validate pass compiles the specs.
 *  - `portify` double-boots services: config + envset, nothing else.
 *  - `run` executes specs: config + envset + specs.
 *  - `evaluation-export` builds its archive from the run record alone.
 *  - `heal` is driven by `run` and is refused as an entry point outright. */
export const STAGE_DEPENDS_ON: Record<FlightStageKey, readonly FlightStageKey[]> = {
  'similarity': [],
  'scout': [],
  'scaffold': [],
  'env-capture': ['scaffold'],
  'docs': ['scaffold'],
  'prd-summary': ['scaffold'],
  'specs-coverage': ['scaffold', 'env-capture', 'prd-summary'],
  'portify': ['scaffold', 'env-capture'],
  'run': ['scaffold', 'env-capture', 'specs-coverage'],
  'heal': ['run'],
  'evaluation-export': ['run'],
}

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
  | 'portify-gate'      // before the portify agent starts: run Parallel setup, or skip (stay serial)
  | 'portify-apply'     // portify agent proposes edits; approve before apply
  | 'run-failed'        // run ended failed/aborted after heal → rerun or export as-is
  | 'export-mode'       // pick the evaluation flavor before exporting: raw | localized
  /** The stage handed its work to the external MCP client that drives the flight
   *  (opts.stageProducer === 'external'): `data` carries the rendered prompt the
   *  client should execute, and the client returns its result on the response's
   *  `data`. Unlike every other kind this is not a question for a human — it is a
   *  work hand-off — but it reuses the checkpoint machinery deliberately: a parked
   *  checkpoint makes run() RETURN, so there is no poll and therefore no idle
   *  deadline to starve (the flaw in the retired poll-based external portify
   *  path). Multi-round stages (portify, heal) park ONCE per engagement and the
   *  client drives the standalone tools; their submit means "check the record
   *  now" — Canary re-reads it and re-parks if it has not settled. It also
   *  accepts choice:"run-internally" so a client that cannot do the job can hand
   *  it back to Canary's own agent instead of failing the stage. */
  | 'external-work'

/** Every option key a checkpoint kind can ever offer.
 *
 *  The VOCABULARY, not the offer: one checkpoint instance may present a subset,
 *  and `prd-source` genuinely does — it drops `continue` when the feature has no
 *  docs to continue with. What is fixed is the set a client may ever be asked to
 *  answer with, which is what every consumer needs to know up front.
 *
 *  Declared here because the option keys are wire values, spent by four
 *  surfaces: the stage that emits them, `respond_flight_checkpoint` over MCP,
 *  the CLI, and the web UI's label map. They used to be inline string literals
 *  at nine stage sites, so nothing connected the emitter to the label — a
 *  renamed key still compiled on both sides and simply degraded the button to
 *  its raw key. `satisfies Record<FlightCheckpointKind, …>` makes a new kind a
 *  compile error until its options are declared here.
 *
 *  `as const satisfies` rather than a plain annotation: the annotation alone
 *  would widen every entry to `string[]` and throw away the literal types that
 *  make a typo at an emit site fail to compile. */
export const CHECKPOINT_OPTIONS = {
  'similarity-choice': ['rerun', 'enhance', 'new'],
  'config-approval': ['approve', 'redraft'],
  'missing-env': ['retry', 'waive'],
  'prd-source': ['continue', 'collect-repo-docs', 'infer-from-diff'],
  'coverage-stuck': ['accept-partial', 'retry'],
  'portify-gate': ['run', 'skip'],
  'portify-apply': ['apply', 'revise', 'cancel'],
  'run-failed': ['rerun', 'export-as-is'],
  'export-mode': ['raw', 'localized'],
  'external-work': ['submit', 'run-internally'],
} as const satisfies Record<FlightCheckpointKind, readonly string[]>

/** The option keys valid for one checkpoint kind. */
export type CheckpointOption<K extends FlightCheckpointKind> =
  (typeof CHECKPOINT_OPTIONS)[K][number]

export interface FlightCheckpoint {
  kind: FlightCheckpointKind
  /** Human-readable question shown in the UI / CLI / MCP result. */
  message: string
  /** Closed choice set when the checkpoint is a pick (e.g. rerun/enhance/new).
   *  Build it from `CHECKPOINT_OPTIONS[kind]` — a bare literal here is how the
   *  emitter and the UI's labels drifted apart. */
  options?: string[]
  /** Checkpoint payload — draft config source, missing key list, open gaps, … */
  data?: unknown
}

/** `data` payload of an `external-work` checkpoint. The prompt/context remain
 *  stage-specific; these fields are the protocol every external hand-off
 *  shares. `takeoverRequestedAt` is written by the web UI when the user asks
 *  Canary to run THIS step. The external client must then stop its work and
 *  acknowledge with choice `run-internally`; until it does, Canary stays
 *  parked so two agents never edit the same files at once. */
export interface ExternalWorkCheckpointData {
  stage?: FlightStageKey
  prompt?: string
  promptPath?: string
  context?: unknown
  handOffId?: string
  lastRejection?: 'stale_submission'
  takeoverRequestedAt?: string
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
  /** Which hand-off this answer is answering — the `handOffId` from an
   *  `external-work` checkpoint's data. Read ONLY for a `submit` on that kind,
   *  where it stops a superseded client's late result from settling the stage
   *  after a resume re-asked the question. Every other checkpoint ignores it, and
   *  a hand-off parked by a pre-upgrade server carries no id to match, so an
   *  in-flight one stays answerable across the upgrade. */
  token?: string
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

/** One immutable agent-session reference belonging to a Flight stage. The
 *  ordered list on `FlightStage` is display provenance only: it records each
 *  session the stage started without changing completion or verdict evidence.
 *  `sidecar` names a per-flight directory containing that session's pinned
 *  `agent-session.json`, so reload can resolve the same transcript after the
 *  stage's mutable live sidecar moves on to a later pass. */
export interface FlightStageAgentSession {
  sidecar: string
  label: string
  startedAt: string
  /** Specs-and-coverage provenance. Other multi-session stages may omit it. */
  phase?: 'authoring' | 'mapping'
  /** One-based specs-and-coverage pass. */
  pass?: number
}

export interface FlightStage {
  key: FlightStageKey
  status: FlightStageStatus
  /** When the stage FIRST started. Never re-stamped on resume — a truthy value
   *  on a `pending` stage is the "interrupted mid-run" marker. Durations do NOT
   *  read this (see `activeMs`): the span startedAt→endedAt includes pauses and
   *  checkpoint waits, which is wall clock, not work. */
  startedAt?: string
  endedAt?: string
  /** Milliseconds of actual stage work, banked segment by segment as the stage
   *  leaves `running` (checkpoint park, pause, settle). The UI reports THIS as
   *  the stage's duration — a flight parked overnight on a question must not
   *  show a nine-hour step. Absent on records from before the field existed;
   *  readers fall back to the startedAt→endedAt span. */
  activeMs?: number
  /** Start of the live segment now accruing — stamped when the stage enters
   *  `running`, cleared whenever the segment is banked into `activeMs`. Its
   *  presence is what makes double-banking impossible. */
  activeSince?: string
  /** Harness-computed proof the stage settled on (boot summary, coverage
   *  ledger snapshot, archive path…) — never agent-asserted. */
  evidence?: unknown
  /** Where `evidence` came from. Absent (the default) = recorded by the stage
   *  adapter when it settled. `workspace` = probed from the workspace at READ
   *  time because the stage never recorded any, so it describes the artifacts as
   *  they are NOW rather than a point-in-time measurement. Never persisted —
   *  the fill happens on the read path (see workspace-evidence.ts). */
  evidenceSource?: 'workspace'
  /** Structured LIVE progress while the stage runs (kept after it settles as
   *  the audit trail). Shape is stage-specific — specs-coverage publishes
   *  `SpecsCoverageProgress` so the UI can render the authoring↔mapping loop
   *  instead of parsing log text. */
  progress?: unknown
  /** What the stage's spawned agent is doing RIGHT NOW. Its own field rather
   *  than a corner of `progress` so publishing it can never clobber a stage's
   *  structured progress (portify's phase mirror, specs-coverage's passes) and
   *  vice versa. Only meaningful while the stage runs — a settled stage's last
   *  snapshot would read as live work, so the UI gates on status. */
  agentActivity?: AgentActivity
  /** Agent sessions in the order this stage started them. Each entry points to
   *  an immutable sidecar ref; the latest matching entry may still be live,
   *  while every earlier entry remains historical Activity. */
  agentSessions?: FlightStageAgentSession[]
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
  /** Who executes the thinking stages that CAN be handed off: scout, docs,
   *  prd-summary, specs↔coverage (authoring AND mapping), portify, the run's
   *  heal engagement, and the export's localized rewrite (also the external
   *  default). `internal` (the default, and the only option for a GUI-started
   *  flight, which has no MCP client at all) spawns the CLI named by `agent`
   *  above / runs the workspace-config loops. `external` parks each of those
   *  stages on an `external-work` checkpoint so the MCP client driving the
   *  flight does the job in its own harness — with its own subagents,
   *  permissions and token accounting — and returns the result via
   *  respond_flight_checkpoint; multi-round stages (portify, run/heal) park
   *  once per engagement while the client drives the standalone tools. Sticky
   *  for the record's lifetime for the same reason `agent` is: a flight that
   *  changes executor mid-pipeline produces stage evidence from two different
   *  sources. Purely mechanical stages (similarity, scaffold, env, the run's
   *  playwright execution, a raw export) have no thinking to move and ignore
   *  it. */
  stageProducer?: 'internal' | 'external'
  /** Base branch for diff-inferred requirements (auto-detected when absent). */
  base?: string
  /** Skip every checkpoint except missing-env. */
  yolo: boolean
  /** R71/W4 autopilot: checkpoints with a safe default answer themselves
   *  (config-approval→approve, prd-source→continue when docs exist and
   *  collect-repo-docs when they don't, coverage-stuck→accept-partial,
   *  portify-gate→run, portify-apply→apply,
   *  run-failed→export-as-is, export-mode→raw — localized instead when
   *  stageProducer is external, where the rewrite is the thinking being handed
   *  off); similarity-choice and
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
  /** When work actually began: stamped by the drive loop's first pass, and
   *  re-stamped by a redo/jump. Distinct from `createdAt`, which is the
   *  record's identity — a queued flight is created long before it starts, and
   *  a redone flight keeps its record but begins again, so ELAPSED off
   *  `createdAt` absorbed sibling runtimes and week-old redos. Readers fall
   *  back to `createdAt` for records from before the field existed. */
  startedAt?: string
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
  /** Present while status is `waiting-for-approval` — which KIND of stop this
   *  is. The slim consumers (pill, picker, suites column, toasts) never load a
   *  manifest, and without this they cannot tell a question aimed at the human
   *  from an `external-work` hand-off, where the work is actively running in
   *  the MCP client that started the flight. The two need opposite treatments:
   *  one is amber and demands a click, the other is live work in progress. */
  checkpointKind?: FlightCheckpointKind
  /** Mirror of `opts.stageProducer` — WHO drives this flight. An externally
   *  driven flight is read-only in the web UI (every decision belongs to the
   *  MCP client that started it), and the slim consumers have to know that
   *  without loading a manifest: the pill must not count it as needing input,
   *  the picker must not offer to resume it, and the toasts must not tell the
   *  user a checkpoint is waiting for them. Absent = internal. */
  stageProducer?: 'internal' | 'external'
  currentStage: FlightStageKey | null
  /** Slim per-stage status summary (feeds the UI's mini progress rail). */
  stages?: Array<{ key: FlightStageKey; status: FlightStageStatus }>
  updatedAt: string
  endedAt?: string
  [key: string]: unknown
}

/** What a stage's spawned agent is doing between the rows that reach
 *  AgentSessionView. That viewer tails the agent CLI's session JSONL, which
 *  only gains a line when a whole content block COMPLETES — so a two-minute
 *  think followed by a ninety-second answer produces two rows minutes apart and
 *  the panel reads as hung. It cost a real flight: a user shut the machine down
 *  mid-answer believing the agent had died. Derived instead from the
 *  `--include-partial-messages` stdout the spawn already receives for its idle
 *  clock (see agent-stream-progress.ts).
 *
 *  `chars`/`tail` describe the answer block being written, and reset when a new
 *  one starts, so they measure THIS answer rather than the whole turn. */
export type AgentActivity =
  | {
      /** `requesting` = waiting on the model; `thinking` = reasoning, no answer
       *  text yet; `writing` = answer text arriving. */
      phase: 'requesting' | 'thinking' | 'writing'
      /** Cumulative thinking tokens the model reported for the current turn. */
      thinkingTokens: number
      chars: number
      /** Tail of the answer text — the proof that words are still arriving. */
      tail: string
    }
  | {
      phase: 'tool'
      thinkingTokens: number
      chars: number
      tail: string
      /** Paired with the phase so "tool call with no tool name" cannot exist. */
      tool: string
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
  /** How many files the producer has touched in the scratch worktree so far,
   *  counted by Canary from the worktree it owns rather than reported by the
   *  producer. Present only while an EXTERNAL client holds the editing window —
   *  the one phase where `status`/`attempt` cannot move and so the stage would
   *  otherwise look frozen (and, before this, get abandoned on the idle budget). */
  editedFiles?: number
}

/** Live shape of the env-capture stage. The dry-run boot is a real run started
 *  through the runs route, so the same reasoning as portify's pin applies: the
 *  id has to outlive the function that started it, or a pause landing mid-boot
 *  has nothing to reach for. Published the moment the run exists — before the
 *  poll — so it survives every later failure arm too. */
export interface EnvCaptureStageProgress {
  runId: string
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
  /** Stage evidence probed from the workspace at read time, keyed by stage.
   *  A DERIVED flight (no record — see derived-stages.ts) has no manifest to
   *  read, so this is where its panels get their facts; the client attaches each
   *  block to the matching stage of its client-only pseudo-manifest. Absent keys
   *  simply have no artifact to report. Never persisted. */
  evidence?: Partial<Record<FlightStageKey, Record<string, unknown>>>
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
  // `split` always yields at least one element (`''.split(/x/)` is `['']`), so
  // the last segment is a string even for an empty or all-separator path — the
  // `|| 'feature'` on the way out is the only fallback this needs.
  const segments = repoPath.replace(/[\\/]+$/, '').split(/[\\/]/)
  const base = segments[segments.length - 1]
  const slug = base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return slug || 'feature'
}
