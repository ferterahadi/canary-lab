import type { RobustnessJobManifest } from '../../../../../../../shared/robustness/jobs'
import { flightStageLabel } from '../../../../../../../shared/flights/stage-labels'
import { loadFeatures } from '../../../../shared/feature-loader'
import { collectPortSlots } from '../../../runs/logic/runtime/service-specs'
import type { StageAdapter, StageContext, StageOutcome } from '../conductor'
import { pollUntil, type FlightStageDeps } from './context'
import { robustnessJob } from './stage-jobs'

// The Robustness Lab stage (D16): once the run is green, every spec file is
// booted again under each atom of the suite's perturbation envelope — latency,
// duplicated writes, a slot restart — through the proxy shim, and whatever
// fails is shrunk to the smallest envelope that still fails it. The stage adds
// nothing to the green verdict and never touches it: its output is FINDINGS
// (or none), read by the pane, the certificate and the repair agent.
//
// Two honest skips, stated as reasons rather than failures: a run that did not
// pass has nothing green to perturb, and a suite whose start commands declare
// no port slot has nothing for the shim to sit in front of — both are facts
// about the suite, not faults in the stage. Harness predicate: the job record
// settled `done`; a matrix that ended `failed`/`aborted` fails the stage with
// the record's own reason.

/** Idle bound, not wall-clock: a matrix is many runs, each re-booting the
 *  services, so a fixed total would kill a large suite that is visibly
 *  progressing. Every cell or probe that settles extends the deadline. */
const ROBUSTNESS_IDLE_TIMEOUT_MS = 30 * 60 * 1000

/** The stage's evidence block, read off the job record. ONE shape for the
 *  conducted stage and the workspace probe (workspace-evidence.ts), so a
 *  derived rail and a flown one render the same facts. Findings are listed by
 *  status, never summed into a pass count — a clean cell leaves no record. */
export function robustnessStageEvidence(job: RobustnessJobManifest): Record<string, unknown> {
  const count = (status: RobustnessJobManifest['findings'][number]['status']) => job.findings.filter((f) => f.status === status).length
  return {
    jobId: job.jobId,
    runId: job.runId,
    cells: job.cells,
    findings: job.findings.length,
    confirmed: count('confirmed'),
    unconfirmed: count('unconfirmed'),
    skipped: job.skipped.length,
  }
}

export function robustnessStage(deps: FlightStageDeps): StageAdapter {
  const readJob = async (jobId: string): Promise<RobustnessJobManifest | null> => {
    const resp = await deps.inject({ method: 'GET', url: `/api/robustness/${encodeURIComponent(jobId)}` })
    return resp.statusCode === 200 ? (resp.json() as RobustnessJobManifest) : null
  }

  const settle = async (ctx: StageContext, jobId: string): Promise<StageOutcome> => {
    // Cells settling, findings landing and shrink probes appending all move
    // the log — that is the liveness signal, and each move republishes the
    // counters so the rail's status line ticks while the matrix runs.
    const progressKey = (j: RobustnessJobManifest | null) => (j ? `${j.cells.done}:${j.log.length}` : 'gone')
    let lastKey: string | undefined
    const job = await pollUntil(
      async () => {
        const j = await readJob(jobId)
        const key = progressKey(j)
        if (j && key !== lastKey) ctx.setProgress(robustnessStageEvidence(j))
        lastKey = key
        return j
      },
      (j) => j === null || j.status !== 'running',
      { what: `robustness job ${jobId}`, timeoutMs: ROBUSTNESS_IDLE_TIMEOUT_MS, signal: ctx.signal, progressKey },
    )
    if (!job) return { kind: 'failed', error: `robustness job ${jobId} disappeared while the stage was waiting on it` }
    if (job.status !== 'done') return { kind: 'failed', error: `robustness matrix ${job.status}: ${job.error ?? 'no reason recorded'}` }
    return { kind: 'done', evidence: robustnessStageEvidence(job) }
  }

  return {
    // The job pinned at START (see run) — the same pointer the re-attach reads.
    teardown: (ctx) => {
      const jobId = ctx.manifest().links?.robustnessJobId
      return jobId ? robustnessJob(deps, jobId) : null
    },
    async run(ctx) {
      const m = ctx.manifest()
      const runId = m.links?.runId
      if (!runId) return { kind: 'failed', error: `no run to perturb — ${flightStageLabel('run')} must settle first` }

      // Resume/replay: the job this flight already started is the answer, still
      // running or already settled — never a second matrix over the same run.
      const priorJobId = m.links?.robustnessJobId
      if (priorJobId) {
        const prior = await readJob(priorJobId)
        if (prior && prior.status !== 'failed' && prior.status !== 'aborted') {
          ctx.appendLog(`[robustness] re-attaching to job ${priorJobId}\n`)
          return settle(ctx, priorJobId)
        }
      }

      // The run's own record, through its route like every other adapter reads
      // its subsystem — not the file, so the read cannot disagree with the pane.
      const runResp = await deps.inject({ method: 'GET', url: `/api/runs/${encodeURIComponent(runId)}` })
      const run = runResp.statusCode === 200 ? (runResp.json() as { manifest?: { status: string; env?: string } }).manifest : undefined
      if (!run) return { kind: 'failed', error: `run ${runId} has no record — nothing to perturb` }
      if (run.status !== 'passed') {
        return { kind: 'skipped', reason: `the test run did not pass (${run.status}) — only green tests are perturbed` }
      }
      const config = loadFeatures(deps.featuresDir).find((f) => f.name === m.feature)
      if (!config || collectPortSlots(config, run.env).length === 0) {
        return {
          kind: 'skipped',
          reason: `no service takes its port from settings, so nothing can be fronted by a proxy — run ${flightStageLabel('portify')} first`,
        }
      }

      const started = await deps.inject({
        method: 'POST',
        url: `/api/features/${encodeURIComponent(m.feature)}/robustness`,
        payload: { runId },
      })
      const body = started.json() as { jobId?: string; error?: string }
      if (started.statusCode !== 202 || !body.jobId) {
        return { kind: 'failed', error: `robustness lab rejected (${started.statusCode}): ${body.error ?? 'unknown'}` }
      }
      // Linked at START, not completion — a pause/crash mid-matrix must leave
      // the pointer behind for teardown and the re-attach above.
      ctx.patchFlight({ links: { robustnessJobId: body.jobId } })
      ctx.appendLog(`[robustness] job ${body.jobId} started over run ${runId}\n`)
      return settle(ctx, body.jobId)
    },
    // R78 restart wipe: drop the job record through its route — it stops a
    // still-running matrix first. The run record is the RUN stage's artifact;
    // a restart entering here keeps it (it is this stage's input).
    async reset(ctx) {
      const jobId = ctx.manifest().links?.robustnessJobId
      if (!jobId) return
      await deps
        .inject({ method: 'DELETE', url: `/api/robustness/${encodeURIComponent(jobId)}` })
        .catch(() => {})
    },
  }
}
