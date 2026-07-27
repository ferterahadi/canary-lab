import { FLIGHT_STAGE_KEYS, type FlightCheckpoint, type FlightCheckpointResponse, type FlightManifest, type FlightOptions, type FlightStage, type FlightStageKey } from './types'
import { publishWorkspaceEvent } from '../../../shared/workspace-events'
import { FlightConductorDeps, abortFlight, drainQueuedFlights, pauseFlight, resumeFlight } from './conductor'
import { stampSystemLine } from './flight-errors'
import { StageContext, StageOutcome, driveControllers, firstOpenStageIndex } from './flight-stages'

/** R71/W4: checkpoint kind → its safe default. A kind is auto-answered only
 *  when the mapped choice is actually among the checkpoint's options — the
 *  docs stage omits `continue` when no docs exist, so prd-source parks exactly
 *  then. similarity-choice and missing-env have no entry: no safe default
 *  exists (a wrong guess re-points the flight / invents secrets). */
export const AUTOPILOT_CHOICE: Record<string, string> = {
  'config-approval': 'approve',
  'prd-source': 'continue',
  'coverage-stuck': 'accept-partial',
  'portify-gate': 'run',
  'portify-apply': 'apply',
  'run-failed': 'export-as-is',
  'export-mode': 'raw',
}

export function autopilotChoice(opts: FlightOptions, checkpoint: FlightCheckpoint): string | null {
  if (opts.autopilot === false || opts.yolo) return null // yolo has its own per-adapter skips
  const choice = AUTOPILOT_CHOICE[checkpoint.kind]
  return choice !== undefined && (checkpoint.options ?? []).includes(choice) ? choice : null
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
          patchStage(stage.key, { log: (cur?.log ?? '') + stampSystemLine(chunk, now()) })
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
