import { isTerminalRunStatus } from '../../../../../../../shared/run-state'
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

async function readManifest(deps: FlightStageDeps, runId: string): Promise<RunManifest | undefined> {
  const resp = await deps.inject({ method: 'GET', url: `/api/runs/${encodeURIComponent(runId)}` })
  return (resp.json() as { manifest?: RunManifest }).manifest
}

export function runStage(deps: FlightStageDeps): StageAdapter {
  const startAndWait = async (ctx: StageContext): Promise<StageOutcome> => {
    const m = ctx.manifest()
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

    const manifest = await pollUntil(
      () => readManifest(deps, runId),
      (man) => Boolean(man && isTerminalRunStatus(man.status)),
      { what: `run ${runId}`, intervalMs: 3000, timeoutMs: RUN_TIMEOUT_MS },
    )
    const status = manifest!.status as 'passed' | 'failed' | 'aborted'
    ctx.patchFlight({ runVerdict: status })
    const evidence = { runId, status, healCycles: manifest!.healCycles }

    if (status === 'passed') return { kind: 'done', evidence }
    if (m.opts.yolo) {
      ctx.appendLog(`[run] ${status} after ${manifest!.healCycles} heal cycle(s) — yolo exports as-is\n`)
      return { kind: 'done', evidence }
    }
    return {
      kind: 'checkpoint',
      checkpoint: {
        kind: 'run-failed',
        message: `Run ${runId} ended ${status} after ${manifest!.healCycles} heal cycle(s). Rerun it, or export the evaluation as-is (status preserved)?`,
        options: ['rerun', 'export-as-is'],
        data: evidence,
      },
    }
  }

  return {
    run: startAndWait,
    async onCheckpointResponse(ctx, response) {
      if (response.choice === 'rerun') return startAndWait(ctx)
      if (response.choice === 'export-as-is') {
        const stage = ctx.manifest().stages.find((s) => s.key === 'run')
        return { kind: 'done', evidence: stage?.checkpoint?.data }
      }
      const stage = ctx.manifest().stages.find((s) => s.key === 'run')
      return { kind: 'checkpoint', checkpoint: stage!.checkpoint! }
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
