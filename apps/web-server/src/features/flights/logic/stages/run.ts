import { isTerminalRunStatus } from '../../../../../../../shared/run-state'
import type { RunSummary } from '../../../runs/logic/run-store'
import type { RunManifest } from '../../../runs/logic/runtime/manifest'
import type { StageAdapter, StageContext, StageOutcome } from '../conductor'
import { pollUntil, type FlightStageDeps } from './context'

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

/** The run's score, straight off the summary artifact — `passed` and `total` are
 *  read, never derived (a test absent from every result list is NOT RUN, so
 *  `total - failed` would silently count it as passed). `failed` is the length of
 *  the failed list, which is what the stage sentence and the flight's evidence
 *  report. Absent summary (older run, never listed) → no count keys at all
 *  rather than zeros that would read as "nothing failed". */
function runCounts(summary: RunSummary | undefined): { passed: number; total: number; failed: number } | undefined {
  if (!summary || typeof summary.total !== 'number' || typeof summary.passed !== 'number') return undefined
  return { passed: summary.passed, total: summary.total, failed: summary.failed?.length ?? 0 }
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
        options: ['rerun', 'export-as-is'],
        data: evidence,
      },
    }
  }

  const startAndWait = async (ctx: StageContext, opts?: { forceNew?: boolean }): Promise<StageOutcome> => {
    const m = ctx.manifest()

    // Resume after a pause/restart: the run this flight started may still be
    // going (or already terminal) — re-attach instead of double-starting.
    if (!opts?.forceNew && m.links?.runId) {
      const existing = await readManifest(deps, m.links.runId)
      if (existing) {
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
    // Aborting the flight aborts its run; a PAUSE deliberately does not — the
    // run keeps its own lifecycle (controls live on the Test Run stage / run
    // detail), and resume re-attaches to it via links.runId.
    async interrupt(ctx, kind) {
      if (kind !== 'abort') return
      const runId = ctx.manifest().links?.runId
      if (!runId) return
      const existing = await readManifest(deps, runId)
      if (!existing || isTerminalRunStatus(existing.status)) return
      await deps.inject({ method: 'POST', url: `/api/runs/${encodeURIComponent(runId)}/abort` })
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
