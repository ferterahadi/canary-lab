import { isTerminalRunStatus } from '../../../../../../../shared/run-state'
import { plural } from '../../../../../../../shared/lib/plural'
import { runCounts } from '../../../runs/logic/run-detail'
import type { RunSummary } from '../../../runs/logic/run-store'
import type { RunManifest } from '../../../runs/logic/runtime/manifest'
import { renderPrompt } from '../../../../shared/prompts'
import type { StageAdapter, StageContext, StageOutcome } from '../conductor'
import { pollUntil, type FlightStageDeps } from './context'
import { runJob } from './stage-jobs'
import { externalWorkCheckpoint, handsOffToClient, parkedOnExternalWork, rejectStaleSubmit } from './externalizable'
import { CHECKPOINT_OPTIONS, type FlightCheckpoint } from '../types'
import { externalAgentSessionForFlight } from '../external-agent-session'

// Start the real run through the runs route and wait for a terminal verdict.
// The flight's verdict IS the run's terminal status (harness-owned). A
// non-green terminal run parks on the run-failed checkpoint (rerun vs
// export-as-is); `--yolo` exports as-is, status preserved, per the PRD.
//
// INTERNAL producer: auto-heal per the workspace's canary-lab.config.json,
// heal semantics untouched, and the stage polls the run to its verdict.
//
// EXTERNAL producer: the heal loop is the client's thinking, so the run is
// started in external-heal mode UNCLAIMED (healAgent claimable:false — no
// auto-heal agent spawns, no synthetic claim blocks the client's own
// claim_heal) and the stage PARKS immediately on one external-work checkpoint
// for the whole engagement. The park is also the notification channel — a
// flight cannot push to an MCP client, so the checkpoint is how the client
// learns it owns heal duty. The client drives the standalone loop (claim_heal
// → wait_for_heal_task → fix APP code → signal_run); its submit means "the run
// is terminal — check it", and consume re-reads the manifest, re-parking while
// the run is still active. No stage-side poll runs in that mode, so no
// wall-clock budget can starve a client mid-repair.
//
// The heal stage below is a read-only mirror either way: it reports what the
// run's heal loop actually did (healCycles from the manifest), never re-runs.

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
  /** Terminal manifest → the stage outcome. One settle for BOTH producers —
   *  the verdict is the run record, never anyone's report of it. */
  const settleVerdict = (
    ctx: StageContext,
    runId: string,
    detail: { manifest?: RunManifest; summary?: RunSummary },
  ): StageOutcome => {
    const m = ctx.manifest()
    const manifest = detail.manifest
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
    const counts = runCounts(detail.summary)
    const evidence = { runId, status, healCycles: manifest!.healCycles, healEnd, ...(counts ? { counts } : {}) }

    if (status === 'passed') return { kind: 'done', evidence }
    if (m.opts.yolo) {
      ctx.appendLog(`[run] ${status} after ${plural(manifest!.healCycles, 'repair cycle')} — yolo exports as-is\n`)
      return { kind: 'done', evidence }
    }
    const whyLine = healEnd?.message ? ` ${healEnd.message}` : ''
    return {
      kind: 'checkpoint',
      checkpoint: {
        kind: 'run-failed',
        // "repair", not "heal": the UI's own tile above this checkpoint says
        // "Repair cycles", and one subsystem gets one name.
        message: `Run ${runId} ${status} after ${plural(manifest!.healCycles, 'repair cycle')}.${whyLine} Start a new run, or build the report as it stands?`,
        options: [...CHECKPOINT_OPTIONS['run-failed']],
        data: evidence,
      },
    }
  }

  const waitForVerdict = async (ctx: StageContext, runId: string): Promise<StageOutcome> => {
    // `readRun` always resolves to an object, so the readiness test lives where
    // it always did — in the predicate, which already had to tolerate a run whose
    // manifest isn't written yet.
    const detail = await pollUntil(
      () => readRun(deps, runId),
      (d) => Boolean(d?.manifest && isTerminalRunStatus(d.manifest.status)),
      { what: `run ${runId}`, intervalMs: 3000, timeoutMs: RUN_TIMEOUT_MS, signal: ctx.signal },
    )
    return settleVerdict(ctx, runId, detail!)
  }

  /** Park the heal engagement on the client. The prompt leads with the repair
   *  rule and the standalone loop; the client's submit means "the run is
   *  terminal — check it". */
  const externalHealHandOff = (ctx: StageContext, runId: string): StageOutcome => {
    const m = ctx.manifest()
    ctx.appendLog(`[run] heal duty handed to the external agent session (run ${runId}, unclaimed)\n`)
    return externalWorkCheckpoint(ctx, 'run', renderPrompt('flight-heal-handoff.md', { runId, feature: m.feature }), {
      message: `Run ${runId} started with heal duty assigned to YOU: claim_heal with your own session id, loop wait_for_heal_task, fix APP code (never tests) and signal_run — then respond submit here once the run is terminal. Canary reads the verdict from the run record itself. Answer run-internally to hand the run back to Canary's own heal agent.`,
      context: { runId },
    })
  }

  /** Re-park the SAME engagement — the ask (drive this run) has not changed,
   *  so the checkpoint is reused wholesale and keeps its hand-off id. */
  const reparkExternal = (ctx: StageContext, checkpoint: FlightCheckpoint, why: string): StageOutcome => {
    ctx.appendLog(`[run] external submit re-parked — ${why}\n`)
    return { kind: 'checkpoint', checkpoint: { ...checkpoint, data: { ...(checkpoint.data as object), lastRejection: why } } }
  }

  const startAndWait = async (
    ctx: StageContext,
    opts?: { forceNew?: boolean; forceInternal?: boolean },
  ): Promise<StageOutcome> => {
    const m = ctx.manifest()
    const external = !opts?.forceInternal && handsOffToClient(ctx)

    // Resume after a pause/restart: the run this flight started may still be
    // going (or have reached a verdict while we weren't watching) — re-attach
    // instead of double-starting, so a run that passed mid-pause still counts.
    //
    // `aborted` is the exception, and it is the pause path's own doing: pausing
    // the flight now kills its run (see `interrupt`), so re-attaching would
    // replay that abort as this stage's verdict and park the user on the
    // run-failed checkpoint — when Continue promised to re-run the step.
    if (!opts?.forceNew && m.links?.runId) {
      const existing = await readRun(deps, m.links.runId)
      if (existing.manifest && existing.manifest.status !== 'aborted') {
        if (isTerminalRunStatus(existing.manifest.status)) {
          ctx.appendLog(`[run] re-attaching to ${m.links.runId} (${existing.manifest.status})\n`)
          return settleVerdict(ctx, m.links.runId, existing)
        }
        // Still going: the external engagement re-parks (a resume must re-issue
        // the hand-off — the park was cleared by the pause); internal re-polls.
        ctx.appendLog(`[run] re-attaching to ${m.links.runId} (${existing.manifest.status})\n`)
        return external ? externalHealHandOff(ctx, m.links.runId) : waitForVerdict(ctx, m.links.runId)
      }
    }

    // External: start the run in external-heal mode, UNCLAIMED. claimable:false
    // is the whole trick — a claim held by `flight:<id>` would block the real
    // client's claim_heal with already-claimed.
    const externalAgentSession = externalAgentSessionForFlight(m)
    const payload = {
      feature: m.feature,
      env: m.opts.env,
      ...(external
        ? {
            healAgent: {
              kind: 'external',
              sessionId: externalAgentSession.sessionId,
              clientKind: externalAgentSession.clientKind,
              ...(externalAgentSession.conversationName
                ? { conversationName: externalAgentSession.conversationName }
                : {}),
              claimable: false,
            },
          }
        : {}),
    }
    let resp = await deps.inject({ method: 'POST', url: '/api/runs', payload })
    let body = resp.json() as Record<string, unknown>
    if (resp.statusCode === 409 && body.type === 'repo_collision_requires_choice') {
      ctx.appendLog(`[run] repo busy (${String(body.conflictingFeature)}) — queueing\n`)
      resp = await deps.inject({ method: 'POST', url: '/api/runs', payload: { ...payload, isolation: 'queue' } })
      body = resp.json() as Record<string, unknown>
    }
    if (resp.statusCode !== 201 && resp.statusCode !== 202) {
      return { kind: 'failed', error: `run start rejected (${resp.statusCode}): ${String(body.error ?? 'unknown')}` }
    }
    const runId = String(body.runId)
    ctx.patchFlight({ links: { runId } })
    if (external) return externalHealHandOff(ctx, runId)
    ctx.appendLog(`[run] ${runId} started (auto-heal per workspace settings)\n`)
    return waitForVerdict(ctx, runId)
  }

  return {
    run: (ctx) => startAndWait(ctx),
    async onCheckpointResponse(ctx, response) {
      // Releasing the heal ENGAGEMENT park, not the run-failed question.
      if (parkedOnExternalWork(ctx, 'run')) {
        const m = ctx.manifest()
        const checkpoint = m.stages.find((s) => s.key === 'run')!.checkpoint!
        const runId = (checkpoint.data as { context?: { runId?: string } } | undefined)?.context?.runId ?? m.links?.runId
        if (response.choice === 'run-internally') {
          ctx.appendLog('[run] client handed the heal duty back — running internally\n')
          if (runId) {
            const existing = await readManifest(deps, runId)
            if (existing && !isTerminalRunStatus(existing.status)) {
              // The orchestrator cannot hot-swap an active external run to a
              // local agent (handoff 409s on active runs) — abort it and start
              // fresh with the workspace heal config. Losing the suite's
              // progress is the documented price of taking the job back mid-run.
              await deps.inject({ method: 'POST', url: `/api/runs/${encodeURIComponent(runId)}/abort`, payload: {} }).catch(() => {})
              await pollUntil(
                () => readManifest(deps, runId),
                (man) => !man || isTerminalRunStatus(man.status),
                { what: `run ${runId} abort before internal takeover`, timeoutMs: 60_000 },
              ).catch(() => {})
              return startAndWait(ctx, { forceNew: true, forceInternal: true })
            }
            if (existing && (existing.status === 'failed' || existing.status === 'aborted')) {
              // Cheaper than a fresh suite: restart just the heal with a local
              // agent (remaining-test mode) through the existing handoff route.
              const handed = await deps.inject({
                method: 'POST',
                url: `/api/runs/${encodeURIComponent(runId)}/heal-agent/handoff`,
                payload: { to: 'auto' },
              })
              if (handed.statusCode < 300) {
                ctx.appendLog(`[run] heal handed to the local agent — following ${runId}\n`)
                return waitForVerdict(ctx, runId)
              }
              // e.g. no local CLI installed — a fresh internal run still works.
              return startAndWait(ctx, { forceNew: true, forceInternal: true })
            }
          }
          return startAndWait(ctx, { forceInternal: true })
        }
        const stale = rejectStaleSubmit(ctx, 'run', response)
        if (stale) return stale
        if (!runId) return { kind: 'failed', error: 'external run hand-off lost its run id' }
        const detail = await readRun(deps, runId)
        if (!detail.manifest) return { kind: 'failed', error: `run ${runId} has no manifest` }
        if (!isTerminalRunStatus(detail.manifest.status)) {
          return reparkExternal(ctx, checkpoint, `run ${runId} is still "${detail.manifest.status}" — keep driving the heal loop (wait_for_heal_task / signal_run) and submit here once it is terminal`)
        }
        return settleVerdict(ctx, runId, detail)
      }
      if (response.choice === 'rerun') {
        // A REPLAYED rerun (resume after a mid-rerun pause) may find the rerun
        // already started — links.runId then points at a live run. Re-attach
        // instead of force-starting a second run into our own repo lock. Under
        // an external producer the re-attach is the engagement park itself.
        const runId = ctx.manifest().links?.runId
        if (runId) {
          const existing = await readManifest(deps, runId)
          if (existing && !isTerminalRunStatus(existing.status)) {
            ctx.appendLog(`[run] rerun already in flight — re-attaching to ${runId} (${existing.status})\n`)
            return handsOffToClient(ctx) ? externalHealHandOff(ctx, runId) : waitForVerdict(ctx, runId)
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
        return { kind: 'skipped', reason: 'nothing needed repairing' }
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
