import { FLIGHT_STAGE_KEYS, type FlightCheckpoint, type FlightCheckpointResponse, type FlightManifest, type FlightOptions, type FlightStage, type FlightStageKey, type FlightStageTimingKey } from './types'
import { publishWorkspaceEvent } from '../../../shared/workspace-events'
import { FlightConductorDeps, abortFlight, drainQueuedFlights, pauseFlight, resumeFlight } from './conductor'
import { stampSystemLine } from './flight-errors'
import { StageContext, StageOutcome, bankAllStageTimings, bankStageActivity, bankStageTiming, buildStageContext, driveControllers, firstOpenStageIndex, startStageTiming } from './flight-stages'

/** R71/W4: checkpoint kind → its safe defaults, best first. The first entry
 *  that is actually among the checkpoint's options wins, so a kind whose option
 *  set changes with the flight's state still has an answer for each shape:
 *  prd-source drops `continue` when no docs exist yet, and there the collector
 *  agent — the same path the UI recommends — is the safe default, because it
 *  produces evidence rather than guessing (an empty-handed collector re-parks
 *  with its reason, and that re-park always reaches a human).
 *  similarity-choice and missing-env have no entry: no safe default exists
 *  (a wrong guess re-points the flight / invents secrets). */
export const AUTOPILOT_CHOICE: Record<string, string[]> = {
  'config-approval': ['approve'],
  'prd-source': ['continue', 'collect-repo-docs'],
  'coverage-stuck': ['accept-partial'],
  'portify-gate': ['run'],
  'portify-apply': ['apply'],
  'run-failed': ['export-as-is'],
  // The INTERNAL default only — an external producer's export defaults to
  // `localized` via the producer-aware branch in autopilotChoice below.
  'export-mode': ['raw'],
}

/** A checkpoint that carries the verdict of a failed prior attempt is a
 *  RE-park, and a re-park is a human moment — the in-drive `autoAnswered`
 *  guard can't see it because the human's own response started a new drive.
 *  Auto-answering here would re-run the collector that just came back empty. */
function afterFailedAttempt(checkpoint: FlightCheckpoint): boolean {
  const data = checkpoint.data as { lastAttempt?: unknown } | undefined
  return data?.lastAttempt !== undefined
}

export function autopilotChoice(opts: FlightOptions, checkpoint: FlightCheckpoint): string | null {
  if (opts.autopilot === false || opts.yolo) return null // yolo has its own per-adapter skips
  if (afterFailedAttempt(checkpoint)) return null
  const options = checkpoint.options ?? []
  // The export's safe default follows the PRODUCER (user decision, 2026-08-21):
  // an external flight wants its thinking external, and the localized rewrite
  // IS this stage's thinking — `raw` would silently take the deterministic
  // path on the one checkpoint where that difference is the product. Internal
  // flights keep `raw` (fast, no agent). A human at the checkpoint (autopilot
  // off, or a re-entered stage) can still pick either.
  if (checkpoint.kind === 'export-mode' && opts.stageProducer === 'external' && options.includes('localized')) {
    return 'localized'
  }
  return AUTOPILOT_CHOICE[checkpoint.kind]?.find((choice) => options.includes(choice)) ?? null
}

export interface DriveOpts {
  /** Response for the stage the loop is re-entering after a checkpoint. */
  checkpointResponse?: FlightCheckpointResponse
}

export async function drive(flightId: string, deps: FlightConductorDeps, opts: DriveOpts = {}): Promise<void> {
  const now = deps.now ?? (() => new Date().toISOString())
  const { store } = deps

  const save = (m: FlightManifest) => {
    store.save(m)
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
      stages: m.stages.map((s) => {
        if (s.key !== key) return s
        // Any status patch that takes the stage out of `running` (settle,
        // checkpoint park) closes its live work segment — banked here so no
        // exit path can forget it. Progress-only patches leave the clock alone.
        const at = now()
        let base = patch.status && patch.status !== 'running' ? bankStageActivity(s, at) : s
        if (patch.status && patch.status !== 'running') {
          const externalPhase = patch.status === 'waiting-for-approval' && patch.checkpoint?.kind === 'external-work'
            ? ((patch.checkpoint.data as { context?: { phase?: unknown } } | undefined)?.context?.phase)
            : undefined
          const preserve: FlightStageTimingKey[] = externalPhase === 'authoring' || externalPhase === 'mapping' ? [externalPhase] : []
          base = bankAllStageTimings(base, at, preserve)
          if (patch.status === 'waiting-for-approval') base = startStageTiming(base, 'checkpoint-wait', at)
        }
        return { ...base, ...patch }
      }),
    }
    save(next)
    return next
  }

  /** Spend the re-entry protection (R78) once its stage settles without ever
   *  parking — otherwise the flag outlives the step it was set for. */
  const clearAskAt = (key: FlightStageKey): void => {
    const m = read()
    if (m.askAtStage === key) save({ ...m, askAtStage: undefined, updatedAt: now() })
  }

  let pendingResponse = opts.checkpointResponse
  // R71/W4: stage:kind pairs already auto-answered this drive — the loop-guard
  // that turns a would-be infinite approve→re-park cycle into a human park.
  const autoAnswered = new Set<string>()
  const controller = new AbortController()
  driveControllers.set(flightId, controller)

  try {
    // ELAPSED starts when work does. A queued flight is created parked and can
    // sit behind its siblings for their whole runtime; stamping here (first
    // drive pass) instead of at creation keeps that wait out of the number.
    {
      const m0 = read()
      if (!m0.startedAt) save({ ...m0, startedAt: now(), updatedAt: now() })
    }
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
          // `activeSince` starts (or keeps) the work clock: preserved when a
          // segment is already accruing — an auto-answered checkpoint re-enters
          // here with the clock still live, and re-stamping would drop the
          // pre-answer work from the stage's duration.
          i === idx
            ? {
                ...bankStageTiming(s, 'checkpoint-wait', now()),
                status: 'running' as const,
                startedAt: s.startedAt ?? now(),
                activeSince: s.activeSince ?? now(),
              }
            : s,
        ),
      }
      save(m)

      // The same builder `interruptStage` uses, so a teardown writes to the stage
      // log exactly the way the stage itself does.
      const ctx: StageContext = buildStageContext(flightId, stage.key, controller.signal, deps)

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
        clearAskAt(stage.key)
        continue
      }
      if (outcome.kind === 'skipped') {
        patchStage(stage.key, { status: 'skipped', endedAt: now(), skipReason: outcome.reason, checkpoint: undefined })
        clearAskAt(stage.key)
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
              const settledAt = now()
              return {
                ...bankAllStageTimings(bankStageActivity(s, settledAt), settledAt),
                status: 'done' as const,
                endedAt: settledAt,
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
        // …and a stage the user explicitly re-entered always reaches them:
        // picking "from a step → X" IS the intent to answer X differently.
        const beforeCheckpoint = read()
        const askHere = beforeCheckpoint.askAtStage === stage.key
        const auto = askHere ? null : autopilotChoice(beforeCheckpoint.opts, outcome.checkpoint)
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
        // The re-entry protection is spent once the user has been asked — a
        // later checkpoint in the same stage autopilots normally again.
        save({
          ...cur,
          status: 'waiting-for-approval',
          askAtStage: askHere ? undefined : cur.askAtStage,
          updatedAt: now(),
        })
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
