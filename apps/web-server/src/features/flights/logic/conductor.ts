import crypto from 'crypto'
import type { FlightStore } from './store'
import {
  FLIGHT_STAGE_KEYS,
  type FlightCheckpoint,
  type FlightCheckpointResponse,
  type FlightManifest,
  type FlightOptions,
  type FlightStage,
  type FlightStageKey,
} from './types'
import { publishWorkspaceEvent, type WorkspaceEventPublisher } from '../../../shared/workspace-events'

// The First Flight conductor — a deterministic, server-owned stage machine
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

export type StageOutcome =
  | { kind: 'done'; evidence?: unknown }
  | { kind: 'skipped'; reason: string }
  | { kind: 'checkpoint'; checkpoint: FlightCheckpoint }
  | { kind: 'failed'; error: string }
  /** Settle this stage as done and continue at a LATER stage, marking the
   *  stages in between skipped (similarity's "rerun" jumps straight to run). */
  | { kind: 'jump'; to: FlightStageKey; evidence?: unknown; skipReason: string }

export interface StageContext {
  /** Fresh manifest snapshot (re-read on every call). */
  manifest(): FlightManifest
  /** Per-flight sidecar dir for stage artifacts / agent-session refs. */
  flightDir: string
  /** Append to the current stage's display log (persists + broadcasts). */
  appendLog(chunk: string): void
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
}

export type StageAdapters = Partial<Record<FlightStageKey, StageAdapter>>

export interface StartFlightArgs {
  feature: string
  /** Resolved realpaths of the target product repos. */
  repoPaths: string[]
  description: string
  opts: FlightOptions
}

export interface FlightConductorDeps {
  store: FlightStore
  adapters: StageAdapters
  now?: () => string
  newFlightId?: () => string
  workspaceEvents?: WorkspaceEventPublisher
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

function freshStages(): FlightStage[] {
  return FLIGHT_STAGE_KEYS.map((key) => ({ key, status: 'pending' as const }))
}

function firstOpenStageIndex(m: FlightManifest): number {
  return m.stages.findIndex((s) => s.status !== 'done' && s.status !== 'skipped')
}

export function startFlight(args: StartFlightArgs, deps: FlightConductorDeps): StartFlightResult {
  const now = deps.now ?? (() => new Date().toISOString())
  const { store } = deps

  // Single-flight: two flights must never conduct the same product repo. The
  // guard is server-side and keyed on the repo realpath set — UI disabling is
  // cosmetic, and a second `fly` from another terminal hits the same index.
  const active = store.activeForRepos(args.repoPaths)
  if (active) throw new FlightConflictError(args.repoPaths, active.flightId)

  const flightId = (deps.newFlightId ?? defaultFlightId)()
  const manifest: FlightManifest = {
    flightId,
    feature: args.feature,
    repoPaths: args.repoPaths,
    description: args.description,
    opts: args.opts,
    status: 'running',
    currentStage: FLIGHT_STAGE_KEYS[0],
    stages: freshStages(),
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
  const manifest: FlightManifest = {
    ...current,
    status: 'aborted',
    currentStage: null,
    updatedAt: now(),
    endedAt: now(),
  }
  store.save(manifest)
  publishWorkspaceEvent(deps.workspaceEvents, { type: 'flights-changed' })
  return manifest
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

  try {
    for (;;) {
      let m = read()
      // Aborted out from under us (abortFlight while an adapter ran).
      if (m.status === 'aborted') return

      const idx = firstOpenStageIndex(m)
      if (idx === -1) {
        save({ ...m, status: 'done', currentStage: null, updatedAt: now(), endedAt: now() })
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
        appendLog: (chunk) => {
          const cur = read().stages.find((s) => s.key === stage.key)
          patchStage(stage.key, { log: (cur?.log ?? '') + chunk })
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
      if (outcome.kind === 'checkpoint') {
        patchStage(stage.key, { status: 'waiting-for-approval', checkpoint: outcome.checkpoint })
        const cur = read()
        save({ ...cur, status: 'waiting-for-approval', updatedAt: now() })
        return
      }
      // failed → park the flight resumable; the stage keeps its error and is
      // flipped back to pending by resumeFlight so the adapter re-runs.
      patchStage(stage.key, { status: 'failed', endedAt: now(), error: outcome.error })
      {
        const cur = read()
        save({ ...cur, status: 'paused', error: outcome.error, updatedAt: now() })
      }
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
  }
}
