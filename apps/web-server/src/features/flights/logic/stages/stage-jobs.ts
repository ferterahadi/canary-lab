import path from 'path'
import { isTerminalRunStatus } from '../../../../../../../shared/run-state'
import { stopAgentProcesses } from '../../../agent-sessions/logic/agent-process'
import type { FlightStageKey } from '../types'
import type { StageContext, StageJob } from '../conductor'
import { stageSidecarDirs } from '../flight-stages'
import type { FlightStageDeps } from './context'

// The four kinds of work a flight stage can own, each behind the one `StageJob`
// handle. Every stage's teardown is `await job.stop(reason)`; what that means
// differs per subsystem, and that difference belongs HERE (or further down, in
// the subsystem itself) rather than in eleven adapters.
//
// Why each one calls its subsystem's own stop instead of reaching for a pid:
// killing a portify workflow's agent directly would orphan its scratch
// worktrees, hold its capacity slot forever, leave the feature's
// feature.config.cjs half-rewritten, and leave a manifest that still says
// `editing`. The subsystem knows all of that; the flight does not, and should
// not have to.
//
// All four swallow non-2xx: the caller is a pause, and a teardown that cannot
// reach its subsystem must not fail the pause.

/** A run — the Test Run stage's run, and env-capture's dry-run boot, which IS a
 *  run. Aborting is what pause has always meant here: while a run is healing,
 *  what is happening is an agent editing the user's repo. */
export function runJob(deps: FlightStageDeps, runId: string): StageJob {
  return {
    id: runId,
    async stop() {
      const resp = await deps.inject({ method: 'GET', url: `/api/runs/${encodeURIComponent(runId)}` })
      const manifest = (resp.json() as { manifest?: { status: string } }).manifest
      // Gone, or already finished — nothing to abort, and re-aborting a settled
      // run would rewrite a verdict the flight may already have read.
      if (!manifest || isTerminalRunStatus(manifest.status)) return
      await deps.inject({ method: 'POST', url: `/api/runs/${encodeURIComponent(runId)}/abort`, payload: {} })
    },
  }
}

/** A portify workflow: the agent editing ports, plus the concurrent double-boot
 *  that verifies it. */
export function portifyJob(deps: FlightStageDeps, workflowId: string): StageJob {
  return {
    id: workflowId,
    async stop() {
      const resp = await deps.inject({ method: 'GET', url: `/api/portify/${encodeURIComponent(workflowId)}` })
      const status = (resp.json() as { status?: string }).status
      // A verified review the user still has to answer SURVIVES a pause. Its diff
      // is exactly what resume re-adopts (findParkedReview), and the startup
      // reclaim keeps it answerable across a restart — cancelling here would
      // discard a verified result the user never declined.
      if (status === 'ready-to-save') return
      // Already settled — cancel would only rewrite its ending.
      if (status === undefined || status === 'saved' || status === 'failed' || status === 'aborted') return
      await deps.inject({ method: 'POST', url: `/api/portify/${encodeURIComponent(workflowId)}/cancel`, payload: {} })
    },
  }
}

/** An evaluation export task. Uses the abort route, NOT the delete: a pause must
 *  leave the record and its log readable. */
export function evaluationExportJob(deps: FlightStageDeps, taskId: string): StageJob {
  return {
    id: taskId,
    async stop() {
      await deps.inject({
        method: 'POST',
        url: `/api/evaluation-exports/${encodeURIComponent(taskId)}/abort`,
        payload: {},
      })
    },
  }
}

/** The agents a stage spawned in this process. Reached by SCOPE rather than by
 *  handle: the spawn happens several layers down (inside `defaultSpawnAgent`, the
 *  PRD distiller, or the coverage annotator), none of which hand the handle back,
 *  and the stage sidecar dir already names it uniquely.
 *
 *  `stop` no-ops when nothing is registered under the scope, which covers every
 *  "no live spawn" case at once — the stage never spawned, its agent already
 *  exited, or an external client is executing the step. So this factory never
 *  has to answer "is a spawn live right now", and the adapter's null case stays
 *  reserved for stages whose SUBSYSTEM POINTER is missing. */
export function agentSpawnJob(ctx: StageContext, key: FlightStageKey): StageJob {
  return {
    id: `agent:${key}`,
    async stop() {
      // specs-coverage is the one stage with two spawns under two dirs (the
      // author and the mapper); stageSidecarDirs knows which.
      for (const dir of stageSidecarDirs(key)) {
        await stopAgentProcesses(path.join(ctx.flightDir, dir))
      }
    },
  }
}
