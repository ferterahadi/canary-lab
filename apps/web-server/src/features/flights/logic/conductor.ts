import crypto from 'crypto'
import type { FlightStore } from './store'
import {
  FLIGHT_STAGE_KEYS,
  isActiveFlightStatus,
  type FlightCheckpoint,
  type FlightCheckpointResponse,
  type FlightManifest,
  type FlightOptions,
  type FlightStage,
  type FlightStageErrorDetail,
  type FlightStageKey,
} from './types'
import { publishWorkspaceEvent, type WorkspaceEventPublisher } from '../../../shared/workspace-events'

// The Flight conductor — a deterministic, server-owned stage machine
// (NOT one giant agent prompt). It advances the stage array sequentially,
// persists the manifest after every transition, pauses on typed checkpoints,
// and computes every stage verdict itself: adapters may spawn agents for
// judgment work, but a stage settles only on the harness-checked outcome the
// adapter returns (boot passed, ledger met target, archive on disk…).
//
// Stage adapters are injected (Phase 3 provides the real ones; tests stub
// them) so the machine's semantics — advance, pause/resume, jump, crash
// recovery, single-flight — are testable in isolation.

export class FlightConflictError extends Error {
  readonly statusCode = 409
  constructor(public readonly repoPaths: string[], public readonly existingFlightId: string) {
    super(`a flight is already active for ${repoPaths.join(', ')} (${existingFlightId})`)
    this.name = 'FlightConflictError'
  }
}

/** A feature has at most ONE flight record. Re-invoking `flight` on a feature
 *  that already has one must say what to do with it — continue (resume from
 *  the first open stage), redo (restart from stage 1, discarding the record's
 *  stage evidence), or jump (start at a chosen stage, prerequisites checked).
 *  Thrown when no mode was given so every surface (CLI prompt, REST 409, MCP
 *  next-text) presents the same three-way choice instead of silently creating
 *  a second record. */
export class FlightExistsError extends Error {
  readonly statusCode = 409
  readonly options = ['continue', 'redo', 'jump'] as const
  constructor(
    public readonly feature: string,
    public readonly existingFlightId: string,
    public readonly existingStatus: FlightManifest['status'],
  ) {
    super(
      `feature "${feature}" already has a flight record (${existingFlightId}, ${existingStatus}) — ` +
        `choose continue (resume where it left off), redo (restart from stage 1), or jump (start at a chosen stage)`,
    )
    this.name = 'FlightExistsError'
  }
}

/** A `--from-stage` entry whose prerequisites are not satisfied. The message
 *  names the missing prerequisite so the caller can fix it, not guess. */
export class FlightStageEntryError extends Error {
  readonly statusCode = 400
  constructor(message: string) {
    super(message)
    this.name = 'FlightStageEntryError'
  }
}

/** A flight's repos + intent are frozen once the record exists — every redo /
 *  jump / continue reuses the stored values. Thrown when a caller passes a
 *  DIFFERENT repo set or description, so the CLI/REST/MCP all reject the edit
 *  with the same escape hatch instead of silently mutating the record. */
export class FlightFrozenError extends Error {
  readonly statusCode = 409
  constructor(public readonly feature: string, what: 'repos' | 'intent') {
    super(
      `${what === 'repos' ? 'repo list' : 'intent'} is frozen for feature "${feature}" — ` +
        `a flight's repos and intent are set when it first starts; delete the flight to start fresh with different ones`,
    )
    this.name = 'FlightFrozenError'
  }
}

export type StageOutcome =
  | { kind: 'done'; evidence?: unknown }
  | { kind: 'skipped'; reason: string }
  | { kind: 'checkpoint'; checkpoint: FlightCheckpoint }
  | { kind: 'failed'; error: string; errorDetail?: FlightStageErrorDetail }
  /** Settle this stage as done and continue at a LATER stage, marking the
   *  stages in between skipped (similarity's "rerun" jumps straight to run). */
  | { kind: 'jump'; to: FlightStageKey; evidence?: unknown; skipReason: string }
  /** Re-open an EARLIER stage (and everything from it up to the current one)
   *  and continue the loop there — the config-approval "redraft" re-runs
   *  scout. Only meaningful from onCheckpointResponse; a forward target is an
   *  error (that's what `jump` is for). */
  | { kind: 'rewind'; to: FlightStageKey; reason: string }

export interface StageContext {
  /** Fresh manifest snapshot (re-read on every call). */
  manifest(): FlightManifest
  /** Per-flight sidecar dir for stage artifacts / agent-session refs. */
  flightDir: string
  /** Aborted when the user pauses or aborts the flight mid-stage. Adapters
   *  pass it to agent spawns / polls so in-flight work stops promptly instead
   *  of running to completion against a parked flight. */
  signal: AbortSignal
  /** Append to the current stage's display log (persists + broadcasts). */
  appendLog(chunk: string): void
  /** Publish the stage's structured live progress (persists + broadcasts,
   *  same channel as appendLog). The last snapshot survives settle as the
   *  audit trail — see FlightStage.progress. */
  setProgress(progress: unknown): void
  /** Merge flight-level fields an adapter is allowed to settle: deliverable
   *  links, the run verdict, and the target feature (similarity re-pointing
   *  the flight at an existing feature). */
  patchFlight(patch: Partial<Pick<FlightManifest, 'links' | 'runVerdict' | 'feature'>>): void
}

export interface StageAdapter {
  run(ctx: StageContext): Promise<StageOutcome>
  /** Consume the response that releases this stage's checkpoint. Absent →
   *  any response re-runs the stage from scratch. */
  onCheckpointResponse?(ctx: StageContext, response: FlightCheckpointResponse): Promise<StageOutcome>
  /** Best-effort teardown of work this stage delegated to another subsystem
   *  (the run stage aborts its run) when the user pauses/aborts the flight.
   *  In-process work is cancelled via ctx.signal instead. Errors are logged
   *  and swallowed — interrupt must never block the pause itself. */
  interrupt?(ctx: StageContext, kind: 'pause' | 'abort'): Promise<void>
}

export type StageAdapters = Partial<Record<FlightStageKey, StageAdapter>>

export type FlightEntryMode = 'continue' | 'redo' | 'jump'

export interface StartFlightArgs {
  feature: string
  /** Resolved realpaths of the target product repos. */
  repoPaths: string[]
  description: string
  opts: FlightOptions
  /** Stage to start at instead of stage 1 (jump / fresh stage entry). Stages
   *  before it are marked `skipped` (skipReason `stage-entry`); prerequisites
   *  are checked via deps.validateStageEntry first. */
  fromStage?: FlightStageKey
  /** What to do when the feature already has a flight record. Absent + record
   *  present → FlightExistsError (the caller shows the three-way choice). */
  mode?: FlightEntryMode
  /** "What went wrong last time" (R74) — stored on the manifest scoped to the
   *  entry stage, whose agent spawn appends it to its prompt. Redo/jump only. */
  feedback?: string
}

export interface FlightConductorDeps {
  store: FlightStore
  adapters: StageAdapters
  now?: () => string
  newFlightId?: () => string
  workspaceEvents?: WorkspaceEventPublisher
  /** Harness-side prerequisite check for a `fromStage` entry: return an error
   *  string naming the missing prerequisite (rejects the start), or null when
   *  the jump is satisfiable. Absent → fromStage entries are rejected. */
  validateStageEntry?: (args: {
    feature: string
    repoPaths: string[]
    fromStage: FlightStageKey
    env: string
    /** Existing flight record for the feature, when jumping on one. */
    existing?: FlightManifest | null
  }) => string | null
}

export interface StartFlightResult {
  manifest: FlightManifest
  /** Resolves when the drive loop parks (checkpoint/pause) or the flight
   *  settles (used by tests; ignored by REST). */
  completion: Promise<void>
}

function defaultFlightId(): string {
  return `fl_${crypto.randomBytes(6).toString('hex')}`
}

/** In-flight drive cancellation, keyed by flightId. One controller per drive
 *  invocation; pause/abort fire it so the running stage's agent spawn / poll
 *  stops promptly. In-memory by design — after a restart there is nothing to
 *  cancel (store reconcile already parked the flight). */
const driveControllers = new Map<string, AbortController>()

/** Best-effort interrupt of the open stage's delegated work (run abort etc.).
 *  Never throws — a broken interrupt must not block the pause/abort itself. */
async function interruptStage(
  flightId: string,
  stageKey: FlightStageKey,
  kind: 'pause' | 'abort',
  deps: FlightConductorDeps,
): Promise<void> {
  const adapter = deps.adapters[stageKey]
  if (!adapter?.interrupt) return
  const { store } = deps
  const ctx: StageContext = {
    manifest: () => {
      const m = store.get(flightId)
      if (!m) throw new Error(`flight not found: ${flightId}`)
      return m
    },
    flightDir: store.flightDir(flightId),
    signal: new AbortController().signal,
    appendLog: () => {},
    setProgress: () => {},
    patchFlight: () => {},
  }
  try {
    await adapter.interrupt(ctx, kind)
  } catch {
    /* best-effort */
  }
}

function sameRepoSet(a: string[], b: string[]): boolean {
  const norm = (paths: string[]) => [...paths].map((p) => p.replace(/[\\/]+$/, '')).sort().join('\n')
  return norm(a) === norm(b)
}

/** Fresh stage array; with `fromStage`, everything before it is pre-skipped
 *  (the stage-entry path — prerequisites were validated by the caller). */
function freshStages(fromStage: FlightStageKey | undefined, now: () => string): FlightStage[] {
  const startIdx = fromStage ? FLIGHT_STAGE_KEYS.indexOf(fromStage) : 0
  return FLIGHT_STAGE_KEYS.map((key, i) =>
    i < startIdx
      ? {
          key,
          status: 'skipped' as const,
          skipReason: 'stage-entry',
          endedAt: now(),
        }
      : { key, status: 'pending' as const },
  )
}

function firstOpenStageIndex(m: FlightManifest): number {
  return m.stages.findIndex((s) => s.status !== 'done' && s.status !== 'skipped')
}

/** Check a fromStage entry through the injected harness validator. */
function checkStageEntry(
  args: StartFlightArgs,
  deps: FlightConductorDeps,
  existing: FlightManifest | null,
): void {
  const fromStage = args.fromStage
  if (!fromStage) return
  if (!FLIGHT_STAGE_KEYS.includes(fromStage)) {
    throw new FlightStageEntryError(`unknown stage: ${String(fromStage)}`)
  }
  if (fromStage === 'similarity') return // stage 1 — a plain start
  if (!deps.validateStageEntry) {
    throw new FlightStageEntryError('stage entry is not supported on this surface')
  }
  const reason = deps.validateStageEntry({
    feature: args.feature,
    repoPaths: args.repoPaths,
    fromStage,
    env: args.opts.env,
    existing,
  })
  if (reason) throw new FlightStageEntryError(reason)
}

export function startFlight(args: StartFlightArgs, deps: FlightConductorDeps): StartFlightResult {
  const now = deps.now ?? (() => new Date().toISOString())
  const { store } = deps

  // Single-flight: two flights must never conduct the same product repo. The
  // guard is server-side and keyed on the repo realpath set — UI disabling is
  // cosmetic, and a second `flight` from another terminal hits the same index.
  const active = store.activeForRepos(args.repoPaths)
  if (active) throw new FlightConflictError(args.repoPaths, active.flightId)

  // One flight record per feature: re-invoking on a feature that already has
  // one never mints a second manifest — it continues, redoes, or jumps the
  // existing record (FlightExistsError when the caller didn't say which).
  const existingEntry = store.latestForFeature(args.feature)
  const existing = existingEntry ? store.get(existingEntry.flightId) : null
  if (existing) {
    if (isActiveFlightStatus(existing.status)) {
      throw new FlightConflictError(existing.repoPaths, existing.flightId)
    }
    const mode: FlightEntryMode | undefined = args.mode ?? (args.fromStage ? 'jump' : undefined)
    if (!mode) throw new FlightExistsError(args.feature, existing.flightId, existing.status)
    if (mode === 'continue') {
      if (existing.status === 'paused') return resumeFlight(existing.flightId, deps)
      throw new FlightExistsError(args.feature, existing.flightId, existing.status)
    }
    // redo / jump: reset the SAME record — prior stage evidence is discarded
    // explicitly, never silently forked into a second flight.
    if (mode === 'jump' && !args.fromStage) {
      throw new FlightStageEntryError('jump requires fromStage')
    }
    // Repos + intent are frozen on the record: empty/identical args reuse the
    // stored values, different ones are rejected (delete the flight to change
    // them). Options (env / coverage target / yolo) stay caller-supplied.
    if (args.repoPaths.length > 0 && !sameRepoSet(args.repoPaths, existing.repoPaths)) {
      throw new FlightFrozenError(args.feature, 'repos')
    }
    const description = args.description.trim()
    if (description && description !== existing.description) {
      throw new FlightFrozenError(args.feature, 'intent')
    }
    checkStageEntry({ ...args, repoPaths: existing.repoPaths }, deps, existing)
    const manifest: FlightManifest = {
      ...existing,
      repoPaths: existing.repoPaths,
      description: existing.description,
      opts: args.opts,
      status: 'running',
      pauseReason: undefined,
      currentStage: args.fromStage ?? FLIGHT_STAGE_KEYS[0],
      stages: freshStages(mode === 'jump' ? args.fromStage : undefined, now),
      feedback: args.feedback?.trim()
        ? { stage: args.fromStage ?? FLIGHT_STAGE_KEYS[0], note: args.feedback.trim() }
        : undefined,
      updatedAt: now(),
      endedAt: undefined,
      error: undefined,
      runVerdict: undefined,
      // A jump straight to evaluation-export was validated AGAINST the old
      // record's run — that runId is the stage's input, so it must survive
      // the reset (the deliverable links are dropped and regenerated).
      links:
        mode === 'jump' && args.fromStage === 'evaluation-export' && existing.links?.runId
          ? { runId: existing.links.runId }
          : undefined,
    }
    store.save(manifest)
    publishWorkspaceEvent(deps.workspaceEvents, { type: 'flights-changed' })
    return { manifest, completion: drive(manifest.flightId, deps) }
  }

  // Fresh record: the caller must actually supply the inputs (a mode-carrying
  // call that found no record to reuse lands here with empty fallbacks).
  if (args.repoPaths.length === 0) {
    throw new FlightStageEntryError(`feature "${args.feature}" has no flight record — repoPaths are required to start one`)
  }
  if (!args.description.trim()) {
    throw new FlightStageEntryError(`feature "${args.feature}" has no flight record — a description is required to start one`)
  }
  checkStageEntry(args, deps, null)

  const flightId = (deps.newFlightId ?? defaultFlightId)()
  const manifest: FlightManifest = {
    flightId,
    feature: args.feature,
    repoPaths: args.repoPaths,
    description: args.description,
    opts: args.opts,
    status: 'running',
    currentStage: args.fromStage ?? FLIGHT_STAGE_KEYS[0],
    stages: freshStages(args.fromStage, now),
    createdAt: now(),
    updatedAt: now(),
  }
  store.save(manifest)
  publishWorkspaceEvent(deps.workspaceEvents, { type: 'flights-changed' })

  const completion = drive(flightId, deps)
  return { manifest, completion }
}

/** Resume a `paused` flight (stage failure or server restart) from its first
 *  open stage. A failed stage was flipped back to `pending` by the pause, so
 *  the adapter re-runs from its own postcondition check. */
export function resumeFlight(flightId: string, deps: FlightConductorDeps): StartFlightResult {
  const store = deps.store
  const now = deps.now ?? (() => new Date().toISOString())
  const current = store.get(flightId)
  if (!current) throw new Error(`flight not found: ${flightId}`)
  if (current.status !== 'paused') {
    throw new Error(`flight ${flightId} is ${current.status}, not paused — nothing to resume`)
  }
  const manifest: FlightManifest = {
    ...current,
    status: 'running',
    pauseReason: undefined,
    error: undefined,
    updatedAt: now(),
    stages: current.stages.map((s) =>
      s.status === 'failed' ? { ...s, status: 'pending' as const, error: undefined } : s,
    ),
  }
  store.save(manifest)
  publishWorkspaceEvent(deps.workspaceEvents, { type: 'flights-changed' })
  return { manifest, completion: drive(flightId, deps) }
}

/** User-initiated pause of an active flight. Parks FIRST (so the drive loop's
 *  re-read sees `paused` before the abort lands — the pause-race rule), then
 *  cancels the in-flight stage work via the drive's AbortController and the
 *  stage's best-effort interrupt hook. The open stage flips back to `pending`
 *  so resume re-runs it from its own postcondition check; a checkpoint that
 *  was parked is cleared the same way (re-running the stage re-issues it). */
export function pauseFlight(flightId: string, deps: FlightConductorDeps): FlightManifest {
  const { store } = deps
  const now = deps.now ?? (() => new Date().toISOString())
  const current = store.get(flightId)
  if (!current) throw new Error(`flight not found: ${flightId}`)
  if (!isActiveFlightStatus(current.status)) {
    throw new Error(`flight ${flightId} is ${current.status}, not active — nothing to pause`)
  }
  const openStage = current.stages.find(
    (s) => s.status === 'running' || s.status === 'waiting-for-approval',
  )
  const manifest: FlightManifest = {
    ...current,
    status: 'paused',
    pauseReason: 'user',
    updatedAt: now(),
    stages: current.stages.map((s) =>
      s.key === openStage?.key ? { ...s, status: 'pending' as const, checkpoint: undefined } : s,
    ),
  }
  store.save(manifest)
  publishWorkspaceEvent(deps.workspaceEvents, { type: 'flights-changed' })
  driveControllers.get(flightId)?.abort()
  if (openStage) void interruptStage(flightId, openStage.key, 'pause', deps)
  return manifest
}

/** "Start over" — restart this record from stage 1 with its own stored
 *  intent/repos/options, so the header button doesn't reconstruct the start
 *  body client-side. Active flights must be paused/aborted first. */
export function redoFlight(
  flightId: string,
  deps: FlightConductorDeps,
  opts: {
    /** Re-enter at this stage instead of stage 1 (Continue → "from a step…"). */
    fromStage?: FlightStageKey
    /** "What went wrong last time" — scoped to the entry stage's agent prompt. */
    feedback?: string
  } = {},
): StartFlightResult {
  const current = deps.store.get(flightId)
  if (!current) throw new Error(`flight not found: ${flightId}`)
  if (isActiveFlightStatus(current.status)) {
    throw new Error(`flight ${flightId} is ${current.status} — pause or abort it before starting over`)
  }
  return startFlight(
    {
      feature: current.feature,
      repoPaths: current.repoPaths,
      description: current.description,
      opts: current.opts,
      mode: opts.fromStage ? 'jump' : 'redo',
      fromStage: opts.fromStage,
      feedback: opts.feedback,
    },
    deps,
  )
}

/** Create a flight record WITHOUT driving it — parked `paused`/`queued` for
 *  the conductor's queue drain (the plan-features launch parks every feature
 *  after the first this way). The feature must not already have a record. */
export function enqueueFlight(
  args: Omit<StartFlightArgs, 'fromStage' | 'mode'>,
  deps: FlightConductorDeps,
): FlightManifest {
  const { store } = deps
  const now = deps.now ?? (() => new Date().toISOString())
  const existing = store.latestForFeature(args.feature)
  if (existing) {
    throw new FlightExistsError(args.feature, existing.flightId, existing.status as FlightManifest['status'])
  }
  const manifest: FlightManifest = {
    flightId: (deps.newFlightId ?? defaultFlightId)(),
    feature: args.feature,
    repoPaths: args.repoPaths,
    description: args.description,
    opts: args.opts,
    status: 'paused',
    pauseReason: 'queued',
    currentStage: FLIGHT_STAGE_KEYS[0],
    stages: freshStages(undefined, now),
    createdAt: now(),
    updatedAt: now(),
  }
  store.save(manifest)
  publishWorkspaceEvent(deps.workspaceEvents, { type: 'flights-changed' })
  return manifest
}

/** Start the next `queued` flight whose repos are free — called whenever a
 *  flight settles (done / stage-failed park / hard fail / abort) and after
 *  boot reconcile. One start per drain: the started flight's own settle
 *  drains the one after it, which is what keeps the batch sequential. A user
 *  pause or a checkpoint park deliberately does NOT drain — the repo lock is
 *  still morally held by the flight the user is working on. */
export function drainQueuedFlights(deps: FlightConductorDeps): void {
  const { store } = deps
  const queued = store
    .list()
    .filter((e) => e.status === 'paused' && e.pauseReason === 'queued')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  for (const entry of queued) {
    if (store.activeForRepos(entry.repoPaths)) continue
    try {
      resumeFlight(entry.flightId, deps)
    } catch {
      continue // raced with a manual start — try the next queued flight
    }
    return
  }
}

/** Delete a NON-ACTIVE flight record (the frozen-repos escape hatch). The
 *  feature and its on-disk artifacts stay — only the flight record goes, so
 *  the pill row returns to "not flown" and a fresh start can pick new
 *  repos/intent. */
export function deleteFlight(flightId: string, deps: FlightConductorDeps): void {
  const { store } = deps
  const current = store.get(flightId)
  if (!current) throw new Error(`flight not found: ${flightId}`)
  if (isActiveFlightStatus(current.status)) {
    throw new Error(`flight ${flightId} is ${current.status} — stop it before deleting`)
  }
  store.remove(flightId)
  publishWorkspaceEvent(deps.workspaceEvents, { type: 'flights-changed' })
}

/** Flip the named stages (and everything after the earliest of them — their
 *  evidence is downstream of the reopened work) back to `pending` on a
 *  NON-ACTIVE flight, so an out-of-band redo (coverage's "Redo from the
 *  start" clearing the PRD) reflects into the flight record live. No-op on
 *  active flights — the running conductor owns those. */
export function reopenStages(
  flightId: string,
  keys: FlightStageKey[],
  deps: FlightConductorDeps,
): FlightManifest | null {
  const { store } = deps
  const now = deps.now ?? (() => new Date().toISOString())
  const current = store.get(flightId)
  if (!current) return null
  if (isActiveFlightStatus(current.status)) return null
  const indices = keys.map((k) => FLIGHT_STAGE_KEYS.indexOf(k)).filter((i) => i >= 0)
  if (indices.length === 0) return null
  const earliest = Math.min(...indices)
  const manifest: FlightManifest = {
    ...current,
    status: 'paused',
    pauseReason: 'user',
    currentStage: FLIGHT_STAGE_KEYS[earliest],
    updatedAt: now(),
    endedAt: undefined,
    error: undefined,
    links: undefined,
    runVerdict: undefined,
    stages: current.stages.map((s, i) =>
      i >= earliest ? { key: s.key, status: 'pending' as const } : s,
    ),
  }
  store.save(manifest)
  publishWorkspaceEvent(deps.workspaceEvents, { type: 'flights-changed' })
  return manifest
}

/** Release a `waiting-for-approval` flight with the client's answer. The
 *  paused stage's adapter consumes the response; the drive loop continues from
 *  whatever outcome it returns. */
export function respondToFlightCheckpoint(
  flightId: string,
  response: FlightCheckpointResponse,
  deps: FlightConductorDeps,
): StartFlightResult {
  const store = deps.store
  const now = deps.now ?? (() => new Date().toISOString())
  const current = store.get(flightId)
  if (!current) throw new Error(`flight not found: ${flightId}`)
  if (current.status !== 'waiting-for-approval') {
    throw new Error(`flight ${flightId} is ${current.status}, not waiting for approval`)
  }
  const stage = current.stages.find((s) => s.status === 'waiting-for-approval')
  if (!stage) throw new Error(`flight ${flightId} has no stage waiting for approval`)

  // Flip to running synchronously so a second respond call races into the
  // status guard above instead of double-driving the flight.
  const manifest: FlightManifest = {
    ...current,
    status: 'running',
    updatedAt: now(),
    stages: current.stages.map((s) =>
      s.key === stage.key ? { ...s, status: 'running' as const, checkpointResponse: response } : s,
    ),
  }
  store.save(manifest)
  publishWorkspaceEvent(deps.workspaceEvents, { type: 'flights-changed' })
  return { manifest, completion: drive(flightId, deps, { checkpointResponse: response }) }
}

/** Mark a flight aborted. The drive loop notices after the in-flight stage
 *  settles and stops advancing; already-spawned stage work is responsible for
 *  its own teardown (run abort, portify cancel) via the existing subsystems. */
export function abortFlight(flightId: string, deps: FlightConductorDeps): FlightManifest {
  const store = deps.store
  const now = deps.now ?? (() => new Date().toISOString())
  const current = store.get(flightId)
  if (!current) throw new Error(`flight not found: ${flightId}`)
  const openStage = current.stages.find(
    (s) => s.status === 'running' || s.status === 'waiting-for-approval',
  )
  const manifest: FlightManifest = {
    ...current,
    status: 'aborted',
    pauseReason: undefined,
    currentStage: null,
    updatedAt: now(),
    endedAt: now(),
    // Same open-stage settle as pause: a terminal record must not keep a live
    // checkpoint — the UI would render an answerable ask that can only 409.
    stages: current.stages.map((s) =>
      s.key === openStage?.key ? { ...s, status: 'pending' as const, checkpoint: undefined } : s,
    ),
  }
  store.save(manifest)
  publishWorkspaceEvent(deps.workspaceEvents, { type: 'flights-changed' })
  driveControllers.get(flightId)?.abort()
  if (openStage) void interruptStage(flightId, openStage.key, 'abort', deps)
  drainQueuedFlights(deps)
  return manifest
}

/** R71/W4: checkpoint kind → its safe default. A kind is auto-answered only
 *  when the mapped choice is actually among the checkpoint's options — the
 *  docs stage omits `continue` when no docs exist, so prd-source parks exactly
 *  then. similarity-choice and missing-env have no entry: no safe default
 *  exists (a wrong guess re-points the flight / invents secrets). */
const AUTOPILOT_CHOICE: Record<string, string> = {
  'config-approval': 'approve',
  'prd-source': 'continue',
  'coverage-stuck': 'accept-partial',
  'portify-apply': 'apply',
  'run-failed': 'export-as-is',
  'export-mode': 'raw',
}

function autopilotChoice(opts: FlightOptions, checkpoint: FlightCheckpoint): string | null {
  if (opts.autopilot === false || opts.yolo) return null // yolo has its own per-adapter skips
  const choice = AUTOPILOT_CHOICE[checkpoint.kind]
  return choice !== undefined && (checkpoint.options ?? []).includes(choice) ? choice : null
}

interface DriveOpts {
  /** Response for the stage the loop is re-entering after a checkpoint. */
  checkpointResponse?: FlightCheckpointResponse
}

async function drive(flightId: string, deps: FlightConductorDeps, opts: DriveOpts = {}): Promise<void> {
  const now = deps.now ?? (() => new Date().toISOString())
  const { store } = deps

  const save = (m: FlightManifest) => {
    store.save(m)
    publishWorkspaceEvent(deps.workspaceEvents, { type: 'flights-changed' })
  }

  const read = (): FlightManifest => {
    const m = store.get(flightId)
    if (!m) throw new Error(`flight disappeared mid-drive: ${flightId}`)
    return m
  }

  const patchStage = (key: FlightStageKey, patch: Partial<FlightStage>): FlightManifest => {
    const m = read()
    const next: FlightManifest = {
      ...m,
      updatedAt: now(),
      stages: m.stages.map((s) => (s.key === key ? { ...s, ...patch } : s)),
    }
    save(next)
    return next
  }

  let pendingResponse = opts.checkpointResponse
  // R71/W4: stage:kind pairs already auto-answered this drive — the loop-guard
  // that turns a would-be infinite approve→re-park cycle into a human park.
  const autoAnswered = new Set<string>()
  const controller = new AbortController()
  driveControllers.set(flightId, controller)

  try {
    for (;;) {
      let m = read()
      // Aborted/paused out from under us (abortFlight/pauseFlight between stages).
      if (m.status === 'aborted' || m.status === 'paused') return

      const idx = firstOpenStageIndex(m)
      if (idx === -1) {
        save({ ...m, status: 'done', currentStage: null, updatedAt: now(), endedAt: now() })
        drainQueuedFlights(deps)
        return
      }

      const stage = m.stages[idx]
      const adapter = deps.adapters[stage.key]
      m = {
        ...m,
        status: 'running',
        currentStage: stage.key,
        updatedAt: now(),
        stages: m.stages.map((s, i) =>
          i === idx ? { ...s, status: 'running' as const, startedAt: s.startedAt ?? now() } : s,
        ),
      }
      save(m)

      const ctx: StageContext = {
        manifest: read,
        flightDir: store.flightDir(flightId),
        signal: controller.signal,
        appendLog: (chunk) => {
          const cur = read().stages.find((s) => s.key === stage.key)
          patchStage(stage.key, { log: (cur?.log ?? '') + chunk })
        },
        setProgress: (progress) => {
          patchStage(stage.key, { progress })
        },
        patchFlight: (patch) => {
          const cur = read()
          save({
            ...cur,
            ...patch,
            links: patch.links ? { ...cur.links, ...patch.links } : cur.links,
            updatedAt: now(),
          })
        },
      }

      let outcome: StageOutcome
      if (!adapter) {
        outcome = { kind: 'failed', error: `no adapter for stage ${stage.key}` }
      } else {
        try {
          const response = pendingResponse
          pendingResponse = undefined
          outcome =
            response && adapter.onCheckpointResponse
              ? await adapter.onCheckpointResponse(ctx, response)
              : await adapter.run(ctx)
        } catch (err) {
          outcome = { kind: 'failed', error: err instanceof Error ? err.message : String(err) }
        }
      }

      // The pause-race rule: the flight may have been paused/aborted while the
      // adapter ran. Work that finished, finished — persist a settled outcome's
      // evidence — but never advance a parked flight, and never record the
      // cancellation itself as `failed` (the open stage was already flipped
      // back to `pending` by pause/abort).
      {
        const after = read()
        if (after.status === 'aborted' || after.status === 'paused') {
          if (outcome.kind === 'done') {
            patchStage(stage.key, {
              status: 'done',
              endedAt: now(),
              ...(outcome.evidence !== undefined ? { evidence: outcome.evidence } : {}),
              checkpoint: undefined,
            })
          } else if (outcome.kind === 'skipped') {
            patchStage(stage.key, {
              status: 'skipped',
              endedAt: now(),
              skipReason: outcome.reason,
              checkpoint: undefined,
            })
          }
          return
        }
      }

      if (outcome.kind === 'done') {
        patchStage(stage.key, {
          status: 'done',
          endedAt: now(),
          ...(outcome.evidence !== undefined ? { evidence: outcome.evidence } : {}),
          checkpoint: undefined,
        })
        continue
      }
      if (outcome.kind === 'skipped') {
        patchStage(stage.key, { status: 'skipped', endedAt: now(), skipReason: outcome.reason, checkpoint: undefined })
        continue
      }
      if (outcome.kind === 'jump') {
        const jump = outcome
        const targetIdx = FLIGHT_STAGE_KEYS.indexOf(jump.to)
        if (targetIdx <= idx) {
          patchStage(stage.key, { status: 'failed', endedAt: now(), error: `illegal jump ${stage.key} → ${jump.to}` })
          const cur = read()
          save({ ...cur, status: 'paused', updatedAt: now() })
          return
        }
        const cur = read()
        save({
          ...cur,
          updatedAt: now(),
          stages: cur.stages.map((s, i) => {
            if (i === idx) {
              return {
                ...s,
                status: 'done' as const,
                endedAt: now(),
                ...(jump.evidence !== undefined ? { evidence: jump.evidence } : {}),
                checkpoint: undefined,
              }
            }
            if (i > idx && i < targetIdx) {
              return { ...s, status: 'skipped' as const, endedAt: now(), skipReason: jump.skipReason }
            }
            return s
          }),
        })
        continue
      }
      if (outcome.kind === 'rewind') {
        const targetIdx = FLIGHT_STAGE_KEYS.indexOf(outcome.to)
        if (targetIdx < 0 || targetIdx > idx) {
          patchStage(stage.key, {
            status: 'failed',
            endedAt: now(),
            error: `illegal rewind ${stage.key} → ${outcome.to}`,
          })
          const cur = read()
          save({ ...cur, status: 'paused', pauseReason: 'stage-failed', updatedAt: now() })
          return
        }
        // Re-open the target stage and everything up to (and including) the
        // current one — their evidence is discarded, the loop re-runs them.
        const cur = read()
        save({
          ...cur,
          updatedAt: now(),
          currentStage: outcome.to,
          stages: cur.stages.map((s, i) =>
            i >= targetIdx && i <= idx ? { key: s.key, status: 'pending' as const } : s,
          ),
        })
        continue
      }
      if (outcome.kind === 'checkpoint') {
        // R71/W4 autopilot: a checkpoint whose safe default is among its
        // options answers itself — logged, recorded on the stage, and guarded
        // so a RE-parked checkpoint (config parse error, unrecognized choice)
        // is never auto-answered twice: the second park reaches the human.
        const auto = autopilotChoice(read().opts, outcome.checkpoint)
        const autoKey = `${stage.key}:${outcome.checkpoint.kind}`
        if (auto && !autoAnswered.has(autoKey)) {
          autoAnswered.add(autoKey)
          ctx.appendLog(`[autopilot] ${outcome.checkpoint.kind}: answered "${auto}" — use Continue → from a step (or the stage's own controls) to choose differently\n`)
          patchStage(stage.key, { checkpoint: outcome.checkpoint, checkpointResponse: { choice: auto } })
          pendingResponse = { choice: auto }
          continue
        }
        patchStage(stage.key, { status: 'waiting-for-approval', checkpoint: outcome.checkpoint })
        const cur = read()
        save({ ...cur, status: 'waiting-for-approval', updatedAt: now() })
        return
      }
      // failed → park the flight resumable; the stage keeps its error and is
      // flipped back to pending by resumeFlight so the adapter re-runs.
      patchStage(stage.key, { status: 'failed', endedAt: now(), error: outcome.error, errorDetail: outcome.errorDetail })
      {
        const cur = read()
        save({ ...cur, status: 'paused', pauseReason: 'stage-failed', error: outcome.error, updatedAt: now() })
      }
      // The park frees the repo lock — a queued sibling may proceed while the
      // human looks at this one (still only one RUNNING flight at a time).
      drainQueuedFlights(deps)
      return
    }
  } catch (err) {
    // A bug in the machine itself (not a stage outcome): fail the flight hard.
    const m = store.get(flightId)
    if (m) {
      save({
        ...m,
        status: 'failed',
        updatedAt: now(),
        endedAt: now(),
        error: err instanceof Error ? err.message : String(err),
      })
    }
    drainQueuedFlights(deps)
  } finally {
    if (driveControllers.get(flightId) === controller) driveControllers.delete(flightId)
  }
}
