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
  | 'config-approval'   // scout's draft feature.config.cjs, before the first boot
  | 'missing-env'       // env capture found keys it cannot source (never skipped)
  | 'prd-source'        // docs stage: drop a PRD or accept the inferred source
  | 'coverage-stuck'    // specs↔coverage loop hit its bound with gaps left
  | 'portify-apply'     // portify agent proposes edits; approve before apply
  | 'run-failed'        // run ended failed/aborted after heal → rerun or export as-is

export interface FlightCheckpoint {
  kind: FlightCheckpointKind
  /** Human-readable question shown in the UI / CLI / MCP result. */
  message: string
  /** Closed choice set when the checkpoint is a pick (e.g. rerun/enhance/new). */
  options?: string[]
  /** Checkpoint payload — draft config source, missing key list, open gaps, … */
  data?: unknown
}

/** The client's answer to a checkpoint. `choice` addresses `options`; `values`
 *  carries user-supplied env values for `missing-env`. */
export interface FlightCheckpointResponse {
  choice?: string
  values?: Record<string, string>
  data?: unknown
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
  /** Appended progress log for display (mirrors coverage-job manifests). */
  log?: string
  /** Why the stage was skipped (similarity jump, already portified, …). */
  skipReason?: string
}

export type FlightStatus =
  | 'running'
  | 'waiting-for-approval'
  /** Resumable stop: a stage failed, or the server restarted mid-stage.
   *  `flight` again (or the resume endpoint) picks up from the first open stage. */
  | 'paused'
  | 'done'
  | 'failed'
  | 'aborted'

export interface FlightOptions {
  /** Envset name the flight captures into / runs against. */
  env: string
  /** Coverage the specs↔coverage loop must reach before advancing (0–100). */
  coverageTarget: number
  /** Base branch for diff-inferred requirements (auto-detected when absent). */
  base?: string
  /** Skip every checkpoint except missing-env. */
  yolo: boolean
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
  /** The stage the conductor is at (or stopped at). Null once terminal. */
  currentStage: FlightStageKey | null
  stages: FlightStage[]
  createdAt: string
  updatedAt: string
  endedAt?: string
  error?: string
  /** Terminal status of the flight's run, once the run stage settles. */
  runVerdict?: 'passed' | 'failed' | 'aborted'
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
  status: FlightStatus
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
