// Robustness Lab REST — start a matrix job for a suite, read it, stop it, drop
// it. Thin over `startRobustnessJob` (the driver) and the shared job store; the
// flight's Robustness stage and the MCP tools both drive it through here so
// admission (green run, declared slots, a valid envelope, single-flight) lives
// in exactly one place.
import type { FastifyInstance } from 'fastify'
import { loadFeatures } from '../../../shared/feature-loader'
import { defaultRobustnessEnvelope, parseRobustnessEnvelope, readRobustnessEnvelope, writeRobustnessEnvelope } from '../../../../../../shared/robustness/envelope'
import type { RobustnessEnvelope } from '../../../../../../shared/robustness/types'
import { startCommandPortSlotCounts } from '../../../../../../shared/launcher/port-injectability'
import { isAuxiliaryExecution } from '../../../../../../shared/verification'
import { listRuns } from '../logic/run-store'
import { readManifest } from '../logic/runtime/manifest'
import { buildRunPaths, runDirFor } from '../logic/runtime/run-paths'
import { collectPortSlots } from '../logic/runtime/service-specs'
import { abortRobustnessJob, RobustnessJobConflictError, startRobustnessJob } from '../logic/robustness/matrix'
import type { RobustnessCellRunner } from '../logic/robustness/cell-runner'
import type { RobustnessJobRunStore } from '../logic/robustness/store'

export interface RobustnessRouteDeps {
  featuresDir: string
  logsDir: string
  store: RobustnessJobRunStore
  runCell: RobustnessCellRunner
}

/** The newest PASSED test run for a suite — the one a matrix is built from
 *  when the caller names none. Boots, benchmarks, verifies and other cells are
 *  not a verdict on the suite's specs, so none of them qualifies. */
export function latestPassedRun(logsDir: string, feature: string): string | undefined {
  return listRuns(logsDir, { feature }).find(
    (r) => r.status === 'passed' && !isAuxiliaryExecution(r.executionType) && r.executionType !== 'verify',
  )?.runId
}

export async function robustnessRoutes(app: FastifyInstance, deps: RobustnessRouteDeps): Promise<void> {
  // Every suite's jobs, newest first — the workspace-wide read behind the
  // Flights pill's live verb (one fetch for the whole suites list, re-run on
  // `robustness-changed`), the same shape the coverage jobs expose.
  app.get('/api/robustness', async () => deps.store.list())

  app.get<{ Params: { name: string } }>('/api/features/:name/robustness', async (req) => {
    return deps.store.forFeature(req.params.name)
  })

  app.post<{
    Params: { name: string }
    Body: {
      /** Defaults to the suite's newest passed run. */
      runId?: string
      /** Defaults to the suite's `robustness/envelope.json`, written with the
       *  default envelope on first use when the suite has none. */
      envelope?: unknown
    }
  }>('/api/features/:name/robustness', async (req, reply) => {
    const feature = req.params.name
    const config = loadFeatures(deps.featuresDir).find((f) => f.name === feature)
    if (!config) {
      reply.code(404)
      return { error: 'feature not found' }
    }

    const runId = req.body?.runId ?? latestPassedRun(deps.logsDir, feature)
    if (!runId) {
      reply.code(409)
      return { error: 'this suite has no passing run yet — the matrix perturbs a green run\'s tests' }
    }
    const run = readManifest(buildRunPaths(runDirFor(deps.logsDir, runId)).manifestPath)
    if (!run || run.feature !== feature) {
      reply.code(404)
      return { error: `run ${runId} not found for this suite` }
    }
    if (run.status !== 'passed') {
      reply.code(409)
      return { error: `run ${runId} did not pass (${run.status}) — only green tests are perturbed` }
    }

    // The shim fronts declared slots; a suite whose start commands declare none
    // has nothing to sit in front of. Same reading as the Ports tab and the
    // stage's own skip, so the three never disagree about "declared".
    if (collectPortSlots(config, run.env).length === 0) {
      const { total } = startCommandPortSlotCounts(config.repos)
      reply.code(400)
      return {
        error: total === 0
          ? 'this suite starts no services, so there is nothing to perturb'
          : 'no service takes its port from settings, so nothing can be fronted by a proxy — run Parallel setup (or declare `ports` on each start command) first',
      }
    }

    const envelope = resolveEnvelope(req.body?.envelope, config.featureDir, collectPortSlots(config, run.env).map((s) => s.name))
    if (!envelope.ok) {
      reply.code(400)
      return { error: envelope.error }
    }

    try {
      const { manifest } = startRobustnessJob({ logsDir: deps.logsDir, feature, runId, envelope: envelope.envelope }, { store: deps.store, runCell: deps.runCell })
      reply.code(202)
      return manifest
    } catch (err) {
      if (err instanceof RobustnessJobConflictError) {
        reply.code(409)
        return { error: err.message, jobId: err.existingJobId }
      }
      reply.code(400)
      return { error: err instanceof Error ? err.message : String(err) }
    }
  })

  app.get<{ Params: { jobId: string } }>('/api/robustness/:jobId', async (req, reply) => {
    const job = deps.store.get(req.params.jobId)
    if (!job) {
      reply.code(404)
      return { error: 'robustness job not found' }
    }
    return job
  })

  /** Stop a running matrix. The record stays, findings so far included: a
   *  paused flight must still be able to read what was found. */
  app.post<{ Params: { jobId: string } }>('/api/robustness/:jobId/abort', async (req, reply) => {
    const job = deps.store.get(req.params.jobId)
    if (!job) {
      reply.code(404)
      return { error: 'robustness job not found' }
    }
    if (job.status !== 'running') return { aborted: false, status: job.status }
    const aborted = abortRobustnessJob(job.jobId)
    // Running on disk but no driver here: the owning process died. Settle it the
    // way boot reconcile would, so the single-flight lock frees now, not at the
    // next restart.
    if (!aborted) deps.store.save({ ...job, status: 'aborted', endedAt: new Date().toISOString(), error: job.error ?? 'Aborted' })
    reply.code(202)
    return { aborted: true, status: 'aborted' }
  })

  /** Drop the record — a flight restart wiping the stage, or history cleanup.
   *  A running job is stopped first so its driver cannot resurrect the file. */
  app.delete<{ Params: { jobId: string } }>('/api/robustness/:jobId', async (req, reply) => {
    const job = deps.store.get(req.params.jobId)
    if (!job) {
      reply.code(404)
      return { error: 'robustness job not found' }
    }
    if (job.status === 'running') abortRobustnessJob(job.jobId)
    deps.store.remove(job.jobId)
    reply.code(204)
    return null
  })
}

type ResolvedEnvelope = { ok: true; envelope: RobustnessEnvelope } | { ok: false; error: string }

/** Request body first (validated); else the suite's own file; else the default,
 *  which is WRITTEN so the human sees — and can edit — what the lab ran under.
 *  A hand-edited file that no longer parses is refused with its reason rather
 *  than silently replaced: the human owns that file. */
function resolveEnvelope(raw: unknown, featureDir: string, slots: string[]): ResolvedEnvelope {
  if (raw !== undefined) {
    const parsed = parseRobustnessEnvelope(raw)
    return parsed.ok ? { ok: true, envelope: parsed.envelope } : { ok: false, error: `invalid envelope: ${parsed.reason}` }
  }
  const read = readRobustnessEnvelope(featureDir)
  if (read.kind === 'ok') return { ok: true, envelope: read.envelope }
  if (read.kind === 'invalid') return { ok: false, error: `the suite's robustness/envelope.json is invalid: ${read.reason}` }
  const envelope = defaultRobustnessEnvelope(slots)
  writeRobustnessEnvelope(featureDir, envelope)
  return { ok: true, envelope }
}
