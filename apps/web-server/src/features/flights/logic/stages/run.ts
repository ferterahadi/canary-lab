import { isTerminalRunStatus } from '../../../../../../../shared/run-state'
import { runCounts } from '../../../runs/logic/run-detail'
import type { RunSummary } from '../../../runs/logic/run-store'
import type { RunManifest } from '../../../runs/logic/runtime/manifest'
import type { StageAdapter, StageContext, StageOutcome } from '../conductor'
import { pollUntil, type FlightStageDeps } from './context'
import { runJob } from './stage-jobs'
import { CHECKPOINT_OPTIONS } from '../types'

// Start the real run through the runs route — auto-heal per the workspace's
// canary-lab.config.json, heal semantics untouched — and wait for a terminal
// verdict. The flight's verdict IS the run's terminal status (harness-owned).
// A non-green terminal run parks on the run-failed checkpoint (rerun vs
// export-as-is); `--yolo` exports as-is, status preserved, per the PRD.
//
// The heal stage is a read-only mirror: it reports what the run's heal loop
// actually did (healCycles from the manifest), it never re-runs anything.

const RUN_TIMEOUT_MS = 90 * 60 * 1000

/** The run's detail — `GET /api/runs/:id` carries the manifest AND the summary in
 *  one response, so the verdict poll gets the score for free. */
async function readRun(
  deps: FlightStageDeps,
  runId: string,
): Promise<{ manifest?: RunManifest; summary?: RunSummary }> {
  const resp = await deps.inject({ method: 'GET', url: `/api/runs/${encodeURIComponent(runId)}` })
  return resp.json() as { manifest?: RunManifest; summary?: RunSummary }
}

async function readManifest(deps: FlightStageDeps, runId: string): Promise<RunManifest | undefined> {
  return (await readRun(deps, runId)).manifest
}


export function runStage(deps: FlightStageDeps): StageAdapter {
  const waitForVerdict = async (ctx: StageContext, runId: string): Promise<StageOutcome> => {
    const m = ctx.manifest()
    // `readRun` always resolves to an object, so the readiness test lives where
    // it always did — in the predicate, which already had to tolerate a run whose
    // manifest isn't written yet.
    const detail = await pollUntil(
      () => readRun(deps, runId),
      (d) => Boolean(d?.manifest && isTerminalRunStatus(d.manifest.status)),
      { what: `run ${runId}`, intervalMs: 3000, timeoutMs: RUN_TIMEOUT_MS, signal: ctx.signal },
    )
    const manifest = detail!.manifest
    const status = manifest!.status as 'passed' | 'failed' | 'aborted'
    ctx.patchFlight({ runVerdict: status })
    // `healEnd` (why auto-heal stopped) rides along in the evidence + checkpoint
    // data so the Test Run hero and the run-failed decision footer can state the
    // give-up reason without a second fetch.
    //
    // R82: the SCORE rides along too (`counts`), so the stage's one-sentence
    // state line can report what actually happened ("4 of 23 tests failed after
    // 1 repair cycle") instead of pointing at a decision below it. Same response
    // the verdict poll already reads — no extra fetch.
    const healEnd = manifest!.healEnd
    const counts = runCounts(detail!.summary)
    const evidence = { runId, status, healCycles: manifest!.healCycles, healEnd, ...(counts ? { counts } : {}) }

    if (status === 'passed') return { kind: 'done', evidence }
    if (m.opts.yolo) {
      ctx.appendLog(`[run] ${status} after ${manifest!.healCycles} heal cycle(s) — yolo exports as-is\n`)
      return { kind: 'done', evidence }
    }
    const whyLine = healEnd?.message ? ` ${healEnd.message}` : ''
    return {
      kind: 'checkpoint',
      checkpoint: {
        kind: 'run-failed',
        message: `Run ${runId} ended ${status} after ${manifest!.healCycles} heal cycle(s).${whyLine} Rerun it, or export the evaluation as-is (status preserved)?`,
        options: [...CHECKPOINT_OPTIONS['run-failed']],
        data: evidence,
      },
    }
  }

  const startAndWait = async (ctx: StageContext, opts?: { forceNew?: boolean }): Promise<StageOutcome> => {
    const m = ctx.manifest()

    // Resume after a pause/restart: the run this flight started may still be
    // going (or have reached a verdict while we weren't watching) — re-attach
    // instead of double-starting, so a run that passed mid-pause still counts.
    //
    // `aborted` is the exception, and it is the pause path's own doing: pausing
    // the flight now kills its run (see `interrupt`), so re-attaching would
    // replay that abort as this stage's verdict and park the user on the
    // run-failed checkpoint — when Continue promised to re-run the step.
    if (!opts?.forceNew && m.links?.runId) {
      const existing = await readManifest(deps, m.links.runId)
      if (existing && existing.status !== 'aborted') {
        ctx.appendLog(`[run] re-attaching to ${m.links.runId} (${existing.status})\n`)
        return waitForVerdict(ctx, m.links.runId)
      }
    }

    let resp = await deps.inject({ method: 'POST', url: '/api/runs', payload: { feature: m.feature, env: m.opts.env } })
    let body = resp.json() as Record<string, unknown>
    if (resp.statusCode === 409 && body.type === 'repo_collision_requires_choice') {
      ctx.appendLog(`[run] repo busy (${String(body.conflictingFeature)}) — queueing\n`)
      resp = await deps.inject({ method: 'POST', url: '/api/runs', payload: { feature: m.feature, env: m.opts.env, isolation: 'queue' } })
      body = resp.json() as Record<string, unknown>
    }
    if (resp.statusCode !== 201 && resp.statusCode !== 202) {
      return { kind: 'failed', error: `run start rejected (${resp.statusCode}): ${String(body.error ?? 'unknown')}` }
    }
    const runId = String(body.runId)
    ctx.patchFlight({ links: { runId } })
    ctx.appendLog(`[run] ${runId} started (auto-heal per workspace settings)\n`)
    return waitForVerdict(ctx, runId)
  }

  return {
    run: (ctx) => startAndWait(ctx),
    async onCheckpointResponse(ctx, response) {
      if (response.choice === 'rerun') {
        // A REPLAYED rerun (resume after a mid-rerun pause) may find the rerun
        // already started — links.runId then points at a live run. Re-attach
        // instead of force-starting a second run into our own repo lock.
        const runId = ctx.manifest().links?.runId
        if (runId) {
          const existing = await readManifest(deps, runId)
          if (existing && !isTerminalRunStatus(existing.status)) {
            ctx.appendLog(`[run] rerun already in flight — re-attaching to ${runId} (${existing.status})\n`)
            return waitForVerdict(ctx, runId)
          }
        }
        return startAndWait(ctx, { forceNew: true })
      }
      if (response.choice === 'export-as-is') {
        const stage = ctx.manifest().stages.find((s) => s.key === 'run')
        return { kind: 'done', evidence: stage?.checkpoint?.data }
      }
      const stage = ctx.manifest().stages.find((s) => s.key === 'run')
      return { kind: 'checkpoint', checkpoint: stage!.checkpoint! }
    },
    // Pausing the flight ends its run, exactly as aborting does — so the reason
    // is not read. "Pause" is read as "stop what is happening", and while the run
    // is HEALING what is happening is an agent editing the user's repo; a pause
    // that left it writing was a broken promise the UI could not explain.
    // Stopping only the run stays available on the Test Run stage (Stop run /
    // Cancel repair), which is where a run-scoped intent belongs.
    //
    // The cost is deliberate: repair cycles in progress are lost and Continue
    // starts a fresh run (see startAndWait's `aborted` note). Losing a heal
    // cycle beats an agent that keeps writing after you asked it to stop.
    teardown(ctx) {
      const runId = ctx.manifest().links?.runId
      return runId ? runJob(deps, runId) : null
    },
    // R78 restart wipe: the run record (logs/runs/<runId>/) is this stage's
    // artifact — delete it through the runs route so the store's own guards
    // and events apply. A still-live run is aborted first; the routes' delete
    // refuses active runs, so the abort must settle before the delete lands.
    async reset(ctx) {
      const runId = ctx.manifest().links?.runId
      if (!runId) return
      const url = `/api/runs/${encodeURIComponent(runId)}`
      const existing = await readManifest(deps, runId)
      if (existing && !isTerminalRunStatus(existing.status)) {
        await deps.inject({ method: 'POST', url: `${url}/abort`, payload: {} }).catch(() => {})
        await pollUntil(
          () => readManifest(deps, runId),
          (man) => !man || isTerminalRunStatus(man.status),
          { what: `run ${runId} abort before restart wipe`, timeoutMs: 60_000 },
        ).catch(() => {})
      }
      await deps.inject({ method: 'DELETE', url }).catch(() => {})
    },
  }
}

export function healStage(deps: FlightStageDeps): StageAdapter {
  return {
    // Owns nothing: this stage only mirrors the run's own heal counters into the
    // flight record. The repair it reports about belongs to the run stage, whose
    // teardown stops it.
    teardown: () => null,
    async run(ctx) {
      const runId = ctx.manifest().links?.runId
      if (!runId) return { kind: 'skipped', reason: 'no run to mirror' }
      const manifest = await readManifest(deps, runId)
      if (!manifest) return { kind: 'skipped', reason: `run ${runId} has no manifest` }
      if ((manifest.healCycles ?? 0) === 0) {
        return { kind: 'skipped', reason: 'run needed no heal' }
      }
      return {
        kind: 'done',
        evidence: {
          runId,
          healCycles: manifest.healCycles,
          healMode: manifest.healMode,
          finalStatus: manifest.status,
        },
      }
    },
  }
}
