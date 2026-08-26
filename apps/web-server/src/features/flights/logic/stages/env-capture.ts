import fs from 'fs'
import path from 'path'
import { plural } from '../../../../../../../shared/lib/plural'
import { captureFeatureEnvFiles } from '../../../config/logic/feature-authoring'
import { publishWorkspaceEvent } from '../../../../shared/workspace-events'
import type { RunManifest } from '../../../runs/logic/runtime/manifest'
import type { FlightStageErrorDetail } from '../types'
import type { EnvCaptureStageProgress } from '../../../../../../../shared/flights/types'
import type { StageAdapter, StageContext, StageOutcome } from '../conductor'
import { featureDirFor, pollUntil, type FlightStageDeps } from './context'
import { runJob } from './stage-jobs'
import type { ScoutDraft } from './scout'
import { CHECKPOINT_OPTIONS } from '../types'

// Capture the scout's detected env files into the flight's envset, then prove
// config + env together with a single dry-run boot (mode:'boot' run via the
// runs route — admission/collision live there; one boot needs no portify).
// The boot IS this stage's harness predicate: the agent's config draft never
// settles on say-so. Missing env files park on the one checkpoint even
// `--yolo` honors: canary never guesses secrets.

const BOOT_VERIFY_TIMEOUT_MS = 5 * 60 * 1000
const LOG_TAIL_LINES = 15

interface BootEvidence {
  runId: string
  services: Array<{ name: string; status?: string }>
}

/** Last lines of the failed service's log — the actual cause (a crash, a bind
 *  error, a stack trace) lives here, so it ships on the stage error instead of
 *  leaving the user a bare verdict to go digging from. */
function serviceLogTail(logPath: string): string {
  try {
    return fs.readFileSync(logPath, 'utf-8').replace(/\s+$/, '').split('\n').slice(-LOG_TAIL_LINES).join('\n')
  } catch {
    return ''
  }
}

async function bootVerify(
  deps: FlightStageDeps,
  ctx: StageContext,
  feature: string,
  env: string,
): Promise<
  | { ok: true; evidence: BootEvidence }
  | { ok: false; error: string; errorDetail?: FlightStageErrorDetail; evidence?: BootEvidence }
> {
  ctx.setTimingPhase?.('service-readiness')
  let resp = await deps.inject({ method: 'POST', url: '/api/runs', payload: { feature, env, mode: 'boot' } })
  let body = resp.json() as Record<string, unknown>
  if (resp.statusCode === 409 && body.type === 'repo_collision_requires_choice') {
    // A flight never steals a repo from a live run — queue behind it.
    ctx.appendLog(`[boot-verify] repo busy (${String(body.conflictingFeature)}) — queueing\n`)
    resp = await deps.inject({ method: 'POST', url: '/api/runs', payload: { feature, env, mode: 'boot', isolation: 'queue' } })
    body = resp.json() as Record<string, unknown>
  }
  if (resp.statusCode !== 201 && resp.statusCode !== 202) {
    return { ok: false, error: `boot request rejected (${resp.statusCode}): ${String(body.error ?? 'unknown')}` }
  }
  const runId = String(body.runId)
  // Pin the id as live progress BEFORE the poll. Until now it lived only in this
  // local, so the boot run was reachable exactly as long as this function was on
  // the stack: the `finally` below stopped it on the normal paths, and nothing
  // could stop it otherwise. Published here rather than after the poll so every
  // failure arm inherits it too.
  ctx.setProgress({ runId } satisfies EnvCaptureStageProgress)
  ctx.appendLog(`[boot-verify] boot run ${runId} started\n`)

  try {
    const manifest = await pollUntil(
      async () => {
        const detail = await deps.inject({ method: 'GET', url: `/api/runs/${encodeURIComponent(runId)}` })
        return (detail.json() as { manifest?: RunManifest }).manifest
      },
      (m) => {
        if (!m) return false
        if (m.status === 'failed' || m.status === 'aborted') return true
        const services = m.services ?? []
        if (m.status !== 'queued' && services.length === 0) return true // nothing to boot (remote-URL feature)
        if (services.some((s) => s.status === 'timeout')) return true
        return services.length > 0 && services.every((s) => s.status === 'ready')
      },
      { what: `boot run ${runId}`, timeoutMs: BOOT_VERIFY_TIMEOUT_MS, signal: ctx.signal },
    )
    const evidence: BootEvidence = {
      runId,
      services: (manifest?.services ?? []).map((s) => ({ name: s.name, status: s.status })),
    }
    const failedService = evidence.services.find((s) => s.status === 'timeout')
    if (manifest?.status === 'failed' || manifest?.status === 'aborted' || failedService) {
      const boot = manifest?.bootFailure
      if (boot) {
        // The run recorded WHY: crashed vs never-healthy, plus the service
        // log — put the verdict and the log's last lines on the stage error
        // so the cause is readable without leaving the flight.
        return {
          ok: false,
          evidence,
          error: boot.reason === 'process-exited'
            ? `service "${boot.service}" crashed during boot — it never reached its health check`
            : `service "${boot.service}" never passed its health check`,
          errorDetail: {
            service: boot.service,
            reason: boot.reason,
            logPath: boot.logPath ?? '',
            logTail: boot.logPath ? serviceLogTail(boot.logPath) : '',
          },
        }
      }
      return {
        ok: false,
        evidence,
        error: failedService
          ? `service "${failedService.name}" never passed its health check`
          : `boot run ${runId} ended ${manifest?.status}`,
      }
    }
    ctx.appendLog(`[boot-verify] all services ready\n`)
    return { ok: true, evidence }
  } finally {
    // The boot proved what it needed to; nothing should keep its services up.
    // This is the NORMAL-completion path (verdict reached, or the poll timed out)
    // — not the stop authority. A pause unwinds `pollUntil` through here too, so
    // it doubles as a backstop, but the stage's own teardown owns stopping the
    // boot deliberately, from the progress pin above. Both are best-effort and
    // idempotent: aborting an already-terminal run is a no-op.
    await deps.inject({ method: 'POST', url: `/api/runs/${encodeURIComponent(runId)}/abort`, payload: {} }).catch(() => {})
  }
}

export function envCaptureStage(deps: FlightStageDeps): StageAdapter {
  const capture = (ctx: StageContext, feature: string, env: string, files: string[]): StageOutcome | null => {
    if (files.length === 0) return null
    const result = captureFeatureEnvFiles(
      { projectRoot: deps.projectRoot, featuresDir: deps.featuresDir, workspaceEvents: deps.workspaceEvents },
      { feature, sources: files.map((sourcePath) => ({ sourcePath, env, confirmOverwrite: true })) },
    )
    if (!result.ok) return { kind: 'failed', error: result.error }
    ctx.appendLog(`[env] captured ${result.captured.length} file(s) into envsets/${env}/\n`)
    return null
  }

  const captureAndBoot = async (ctx: StageContext, files: string[]): Promise<StageOutcome> => {
    const m = ctx.manifest()
    const failed = capture(ctx, m.feature, m.opts.env, files)
    if (failed) return failed
    const boot = await bootVerify(deps, ctx, m.feature, m.opts.env)
    if (!boot.ok) return { kind: 'failed', error: boot.error, errorDetail: boot.errorDetail }
    return { kind: 'done', evidence: { captured: files.length, boot: boot.evidence } }
  }

  const detectedFiles = (ctx: StageContext): string[] => {
    const scout = ctx.manifest().stages.find((s) => s.key === 'scout')
    const draft = scout?.evidence as ScoutDraft | undefined
    return (draft?.envFiles ?? []).filter((f) => typeof f === 'string')
  }

  return {
    // The dry-run boot, read from the progress pin the stage published when it
    // started the run. A boot run IS a run, so it reuses runJob.
    teardown: (ctx) => {
      const stage = ctx.manifest().stages.find((s) => s.key === 'env-capture')
      const runId = (stage?.progress as EnvCaptureStageProgress | undefined)?.runId
      return runId ? runJob(deps, runId) : null
    },
    async run(ctx) {
      const files = detectedFiles(ctx)
      const missing = files.filter((f) => !fs.existsSync(f))
      if (missing.length > 0) {
        return {
          kind: 'checkpoint',
          checkpoint: {
            kind: 'missing-env',
            message: `${plural(missing.length, 'settings file')} the app needs ${missing.length === 1 ? 'is' : 'are'} missing. Paste the values below (Canary writes the file and saves a copy), skip them, or create the files yourself and re-check. Canary never guesses secrets.`,
            options: [...CHECKPOINT_OPTIONS['missing-env']],
            data: { missing },
          },
        }
      }
      return captureAndBoot(ctx, files)
    },
    async onCheckpointResponse(ctx, response) {
      const stage = ctx.manifest().stages.find((s) => s.key === 'env-capture')
      const missing = ((stage?.checkpoint?.data as { missing?: string[] } | undefined)?.missing ?? [])
      if (response.values && Object.keys(response.values).length > 0 && missing.length > 0) {
        // User supplied the keys: materialize the first missing file, then re-run.
        const target = missing[0]
        fs.mkdirSync(path.dirname(target), { recursive: true })
        const lines = Object.entries(response.values).map(([k, v]) => `${k}=${v}`)
        fs.writeFileSync(target, lines.join('\n') + '\n')
        ctx.appendLog(`[env] wrote ${lines.length} value(s) to ${target}\n`)
        return this.run!(ctx)
      }
      if (response.choice === 'waive') {
        const files = detectedFiles(ctx).filter((f) => fs.existsSync(f))
        ctx.appendLog(`[env] missing env files waived — capturing the ${files.length} present\n`)
        return captureAndBoot(ctx, files)
      }
      return this.run!(ctx)
    },
    // R78 restart wipe: drop the envset this stage captured for the flight's
    // env (user-supplied values included — explicit ruling). The boot run it
    // verified with was already aborted + is not a deliverable, so no run
    // record cleanup belongs here.
    async reset(ctx) {
      const m = ctx.manifest()
      const envsetDir = path.join(featureDirFor(deps, m.feature), 'envsets', m.opts.env)
      if (!fs.existsSync(envsetDir)) return
      fs.rmSync(envsetDir, { recursive: true, force: true })
      publishWorkspaceEvent(deps.workspaceEvents, { type: 'envsets-changed', feature: m.feature })
    },
  }
}
