import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { FLIGHT_STAGE_KEYS, type AgentActivity, type FlightCheckpoint, type FlightCheckpointResponse, type FlightManifest, type FlightStage, type FlightStageErrorDetail, type FlightStageKey } from './types'
import { FlightConductorDeps, StartFlightArgs, redoFlight, startFlight } from './conductor'
import { drive } from './flight-drive'
import { FlightStageEntryError } from './flight-errors'

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
  /** Publish what this stage's spawned agent is doing right now. A separate
   *  channel from `setProgress` on purpose: the two are written by different
   *  writers at very different rates (an agent streams; a stage transitions),
   *  so sharing one field would have each clobbering the other. Adapters get
   *  this for free by piping agent output through `agentProgressSink`. */
  setAgentActivity(activity: AgentActivity): void
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
  /** R78 restart wipe: delete everything this stage produced on disk, as if it
   *  never ran — including user-supplied inputs the stage collected (explicit
   *  user ruling: a restart rewinds the step to zero). Invoked ONLY on the
   *  explicit restart entry path (startFlight mode redo/jump, redoFlight) for
   *  the entry stage and every later stage, in order — never on resume.
   *  ctx.manifest() returns the PRIOR record (the one being discarded), so old
   *  deliverable links (runId, evaluationTaskId) are still readable. Same
   *  error posture as interrupt: best-effort, never blocks the restart. */
  reset?(ctx: StageContext): Promise<void>
}

export type StageAdapters = Partial<Record<FlightStageKey, StageAdapter>>

export type FlightEntryMode = 'continue' | 'redo' | 'jump'

export function defaultFlightId(): string {
  return `fl_${crypto.randomBytes(6).toString('hex')}`
}

/** In-flight drive cancellation, keyed by flightId. One controller per drive
 *  invocation; pause/abort fire it so the running stage's agent spawn / poll
 *  stops promptly. In-memory by design — after a restart there is nothing to
 *  cancel (store reconcile already parked the flight). */
export const driveControllers = new Map<string, AbortController>()

/** Best-effort interrupt of the open stage's delegated work (run abort etc.).
 *  Never throws — a broken interrupt must not block the pause/abort itself. */
export async function interruptStage(
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
    setAgentActivity: () => {},
    patchFlight: () => {},
  }
  try {
    await adapter.interrupt(ctx, kind)
  } catch {
    /* best-effort */
  }
}

/** Per-stage sidecar dirs under `<flightDir>/` (agent-session refs the stage
 *  panel resolves transcripts from). Almost always the stage key itself; the
 *  specs loop's SECOND agent (the coverage mapper) lives under `coverage-map`. */
export function stageSidecarDirs(key: FlightStageKey): string[] {
  return key === 'specs-coverage' ? ['specs-coverage', 'coverage-map'] : [key]
}

/** R78: rewind the feature to the state just before `entry` ran — invoke each
 *  stage's reset (entry stage and every later one, in order) against the PRIOR
 *  record, then drop the stage's sidecar dir so the panel can never resolve a
 *  discarded attempt's transcript (even for stages with no reset of their own).
 *  Best-effort throughout: a broken wipe must not block the restart itself. */
export async function resetStagesForRestart(
  prior: FlightManifest,
  entry: FlightStageKey,
  deps: FlightConductorDeps,
): Promise<void> {
  // `entry` is always a real stage key here: `checkStageEntry` rejects an
  // unknown `fromStage` before any restart path reaches this, so the index
  // lookup cannot miss.
  const startIdx = FLIGHT_STAGE_KEYS.indexOf(entry)
  const flightDir = deps.store.flightDir(prior.flightId)
  const ctx: StageContext = {
    manifest: () => prior,
    flightDir,
    signal: new AbortController().signal,
    appendLog: () => {},
    setProgress: () => {},
    setAgentActivity: () => {},
    patchFlight: () => {},
  }
  for (const key of FLIGHT_STAGE_KEYS.slice(startIdx)) {
    const adapter = deps.adapters[key]
    if (adapter?.reset) {
      try {
        await adapter.reset(ctx)
      } catch {
        /* best-effort */
      }
    }
    for (const dir of stageSidecarDirs(key)) {
      try {
        fs.rmSync(path.join(flightDir, dir), { recursive: true, force: true })
      } catch {
        /* best-effort */
      }
    }
  }
}

export function sameRepoSet(a: string[], b: string[]): boolean {
  const norm = (paths: string[]) => [...paths].map((p) => p.replace(/[\\/]+$/, '')).sort().join('\n')
  return norm(a) === norm(b)
}

/** Fresh stage array; with `fromStage`, everything before it is pre-skipped
 *  (the stage-entry path — prerequisites were validated by the caller). */
export function freshStages(fromStage: FlightStageKey | undefined, now: () => string): FlightStage[] {
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

/** Jump re-entry on an EXISTING record: stages before `fromStage` keep their
 *  prior records verbatim, and only `fromStage` and every later stage reset to
 *  pending. A jump rewinds the chosen step and its successors (resetStagesForRestart
 *  wipes those on disk); the earlier steps already ran in THIS flight, so their
 *  `done` status, evidence, log and agent-session refs stay true and the UI can
 *  still show their history. Contrast `freshStages(fromStage)`, which pre-skips
 *  earlier stages as `stage-entry` — correct only for a brand-new flight that
 *  genuinely never ran them, NOT for a restart of a flight that did. */
export function stagesForJump(
  existing: FlightManifest,
  fromStage: FlightStageKey,
  now: () => string,
): FlightStage[] {
  const startIdx = FLIGHT_STAGE_KEYS.indexOf(fromStage)
  return FLIGHT_STAGE_KEYS.map((key, i) => {
    if (i >= startIdx) return { key, status: 'pending' as const }
    const prior = existing.stages.find((s) => s.key === key)
    // A well-formed record carries every stage; fall back to the stage-entry
    // skip only if a prior record somehow lacks this earlier stage.
    return prior ?? { key, status: 'skipped' as const, skipReason: 'stage-entry', endedAt: now() }
  })
}

export function firstOpenStageIndex(m: FlightManifest): number {
  return m.stages.findIndex((s) => s.status !== 'done' && s.status !== 'skipped')
}

/** Check a fromStage entry through the injected harness validator. */
export function checkStageEntry(
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
