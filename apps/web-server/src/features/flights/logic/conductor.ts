import type { FlightStore } from './store'
import { FLIGHT_STAGE_KEYS, isActiveFlightStatus, type FlightCheckpointResponse, type FlightManifest, type FlightOptions, type FlightStageKey } from './types'
import { publishWorkspaceEvent, type WorkspaceEventPublisher } from '../../../shared/workspace-events'
import { drive } from './flight-drive'
import { FlightConflictError, FlightExistsError, FlightFrozenError, FlightNotParkedError, FlightStageEntryError } from './flight-errors'
import { FlightEntryMode, StageAdapters, checkStageEntry, defaultFlightId, driveControllers, firstOpenStageIndex, freshStages, interruptStage, resetStagesForRestart, sameRepoSet, stagesForJump } from './flight-stages'

export { abortFlight, deleteFlight, drainQueuedFlights, enqueueFlight, removeFlightRecordsForFeature } from './flight-queue'

export { FlightConflictError, FlightExistsError, FlightFrozenError, FlightNotParkedError, FlightStageEntryError, stampSystemLine } from './flight-errors'

export type { FlightEntryMode, StageAdapter, StageAdapters, StageContext, StageJob, StageOutcome } from './flight-stages'

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
  /** Evidence links consumed by a direct stage entry after validation. A
   *  standalone run entering Evaluation Export is the current use. */
  resolveStageEntryLinks?: (args: {
    feature: string
    repoPaths: string[]
    fromStage: FlightStageKey
    env: string
    existing?: FlightManifest | null
  }) => FlightManifest['links'] | undefined
}

export interface StartFlightResult {
  manifest: FlightManifest
  /** Resolves when the drive loop parks (checkpoint/pause) or the flight
   *  settles (used by tests; ignored by REST). */
  completion: Promise<void>
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
    // Repos + intent are frozen against PARTIAL re-entry (jump): the surviving
    // stage artifacts were built from them, so changing them would make the
    // record lie. A full restart (redo) discards every stage's evidence — new
    // values are accepted there and replace the stored ones (R75: "start
    // fresh"). Empty/identical args always reuse the stored values. Options
    // (env / coverage target / yolo) stay caller-supplied either way.
    const wantsNewRepos = args.repoPaths.length > 0 && !sameRepoSet(args.repoPaths, existing.repoPaths)
    const trimmedDescription = args.description.trim()
    const wantsNewIntent = trimmedDescription !== '' && trimmedDescription !== existing.description
    if (mode !== 'redo') {
      if (wantsNewRepos) throw new FlightFrozenError(args.feature, 'repos')
      if (wantsNewIntent) throw new FlightFrozenError(args.feature, 'intent')
    }
    const nextRepoPaths = mode === 'redo' && wantsNewRepos ? args.repoPaths : existing.repoPaths
    const nextDescription = mode === 'redo' && wantsNewIntent ? trimmedDescription : existing.description
    const entryLinks = checkStageEntry({ ...args, repoPaths: nextRepoPaths }, deps, existing)
    const manifest: FlightManifest = {
      ...existing,
      repoPaths: nextRepoPaths,
      description: nextDescription,
      // R79: the conducting agent is sticky like repos/intent — the surviving
      // artifacts were produced by it. Jump keeps the stored agent regardless
      // of the caller; a full redo may change it (omitted → stored survives).
      // `stageProducer` is sticky for exactly the same reason: a flight that
      // switched executor mid-pipeline would hold stage evidence from two
      // different producers, and the earlier stages' artifacts are what the
      // later ones read.
      opts: {
        ...args.opts,
        ...(mode === 'redo'
          ? { agent: args.opts.agent ?? existing.opts.agent }
          : existing.opts.agent
            ? { agent: existing.opts.agent }
            : {}),
        // Resolved, never omitted: the MCP layer now DEFAULTS this per client, so
        // leaving it absent would let that default spread onto a record whose
        // earlier stages already ran internally — the two-producer evidence the
        // comment above rules out. A pre-existing record with no stored value ran
        // internally by definition, so that is what it keeps.
        ...(mode === 'redo'
          ? { stageProducer: args.opts.stageProducer ?? existing.opts.stageProducer }
          : { stageProducer: existing.opts.stageProducer ?? 'internal' }),
      },
      status: 'running',
      pauseReason: undefined,
      currentStage: args.fromStage ?? FLIGHT_STAGE_KEYS[0],
      // A jump preserves the earlier stages that already ran on this record (so
      // their history survives); a full redo starts every stage fresh.
      stages: mode === 'jump' && args.fromStage
        ? stagesForJump(existing, args.fromStage, now)
        : freshStages(undefined, now),
      feedback: args.feedback?.trim()
        ? { stage: args.fromStage ?? FLIGHT_STAGE_KEYS[0], note: args.feedback.trim() }
        : undefined,
      // R78: the user chose to re-run this step, so its first checkpoint reaches
      // them even under autopilot — otherwise the safe default re-decides it
      // within the same tick and a deliberate redo looks exactly like a resume.
      askAtStage: args.fromStage ?? FLIGHT_STAGE_KEYS[0],
      updatedAt: now(),
      endedAt: undefined,
      error: undefined,
      runVerdict: undefined,
      // A jump straight to evaluation-export was validated AGAINST the old
      // record's run — that runId is the stage's input, so it must survive
      // the reset (the deliverable links are dropped and regenerated).
      links:
        mode === 'jump' && args.fromStage === 'evaluation-export'
          ? (existing.links?.runId ? { runId: existing.links.runId } : entryLinks)
          : undefined,
    }
    store.save(manifest)
    // R78: an explicit restart wipes the entry stage's artifacts and every
    // later stage's — BEFORE the drive re-runs anything, so no adapter can
    // mistake a discarded attempt's leftovers for prior state. `existing` is
    // the pre-reset snapshot: resets read the old deliverable links from it.
    const entryStage = mode === 'jump' ? args.fromStage! : FLIGHT_STAGE_KEYS[0]
    const completion = resetStagesForRestart(existing, entryStage, deps).then(() =>
      drive(manifest.flightId, deps),
    )
    return { manifest, completion }
  }

  // Fresh record: the caller must actually supply the inputs (a mode-carrying
  // call that found no record to reuse lands here with empty fallbacks).
  if (args.repoPaths.length === 0) {
    throw new FlightStageEntryError(`feature "${args.feature}" has no flight record — repoPaths are required to start one`)
  }
  if (!args.description.trim()) {
    throw new FlightStageEntryError(`feature "${args.feature}" has no flight record — a description is required to start one`)
  }
  const entryLinks = checkStageEntry(args, deps, null)

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
    links: entryLinks,
    createdAt: now(),
    updatedAt: now(),
  }
  store.save(manifest)

  const completion = drive(flightId, deps)
  return { manifest, completion }
}

/** Resume a `paused` flight (stage failure or server restart) from its first
 *  open stage. A failed stage was flipped back to `pending` by the pause, so
 *  the adapter re-runs from its own postcondition check.
 *
 *  Resume CONTINUES from the last state — every settled stage keeps its
 *  evidence and its recorded checkpoint answers, and an answer the open stage
 *  was executing when paused is REPLAYED (never re-asked). Resetting a step to
 *  its initial state is what "From a step…" (redo/jump) is for; it discards
 *  the target stage's evidence and everything after it. */
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
  // Seamless resume: a stage paused (or crash-reconciled) MID-EXECUTION of a
  // checkpoint answer still carries that answer — replay it so the stage picks
  // up the user's choice instead of re-parking the question. pauseFlight
  // clears the answer when it was already spent (paused while parked), so a
  // stale choice never replays.
  const openIdx = firstOpenStageIndex(manifest)
  const replay = openIdx >= 0 ? manifest.stages[openIdx].checkpointResponse : undefined
  return { manifest, completion: drive(flightId, deps, replay ? { checkpointResponse: replay } : {}) }
}

/** R78: flip autopilot on a flight that already exists, in ANY status — it is a
 *  preference, not a start-time-only option, and the drive re-reads `opts` at
 *  every checkpoint so the next one honours the new value. A checkpoint the
 *  flight is ALREADY parked on is deliberately left alone: the user is looking
 *  at it, and auto-answering it out from under them discards the very choice
 *  they opened. */
export function setFlightAutopilot(
  flightId: string,
  autopilot: boolean,
  deps: FlightConductorDeps,
): FlightManifest {
  const { store } = deps
  const now = deps.now ?? (() => new Date().toISOString())
  const current = store.get(flightId)
  if (!current) throw new Error(`flight not found: ${flightId}`)
  const manifest: FlightManifest = {
    ...current,
    opts: { ...current.opts, autopilot },
    updatedAt: now(),
  }
  store.save(manifest)
  return manifest
}

/** User-initiated pause of an active flight. Parks FIRST (so the drive loop's
 *  re-read sees `paused` before the abort lands — the pause-race rule), then
 *  cancels the in-flight stage work via the drive's AbortController and AWAITS
 *  the open stage's teardown, so everything the user can see happening — a
 *  spawned agent, a run, a portify workflow, an export — is stopped before this
 *  resolves. The route replies off the back of it, and "we sent a signal" is not
 *  a promise worth making. The open stage flips back to `pending` so resume
 *  re-runs it from its own postcondition check; a checkpoint that was parked is
 *  cleared the same way (re-running the stage re-issues it). */
export async function pauseFlight(flightId: string, deps: FlightConductorDeps): Promise<FlightManifest> {
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
      s.key === openStage?.key
        ? {
            ...s,
            status: 'pending' as const,
            checkpoint: undefined,
            // An answer the stage was EXECUTING when paused survives — resume
            // replays it (seamless). An answer that already produced the park
            // the user paused on is spent; keeping it would replay a stale
            // choice instead of re-asking.
            ...(openStage.status === 'waiting-for-approval' ? { checkpointResponse: undefined } : {}),
          }
        : s,
    ),
  }
  store.save(manifest)
  driveControllers.get(flightId)?.abort()
  // Awaited, not fired and forgotten. The park above already happened, so the
  // drive cannot advance while we wait, and the pause-race rule still holds.
  if (openStage) await interruptStage(flightId, openStage.key, 'pause', deps)
  // Re-read: the teardown writes its own log line through the store, so the
  // snapshot built above is already one write stale. Callers render this
  // response — a client shown a record with no teardown line would have to wait
  // for the broadcast to learn what stopped. Falls back to the snapshot only if
  // the record was deleted out from under us mid-teardown.
  return store.get(flightId) ?? manifest
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
    throw new FlightNotParkedError(flightId, current.status, current.pauseReason)
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
  return { manifest, completion: drive(flightId, deps, { checkpointResponse: response }) }
}
