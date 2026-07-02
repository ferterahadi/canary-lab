import fs from 'fs'
import path from 'path'
import { captureFeatureEnvFiles } from '../../../config/logic/feature-authoring'
import { publishWorkspaceEvent } from '../../../../shared/workspace-events'
import type { RunManifest } from '../../../runs/logic/runtime/manifest'
import type { StageAdapter, StageContext, StageOutcome } from '../conductor'
import { pollUntil, type FlightStageDeps } from './context'
import type { ScoutDraft } from './scout'

// Capture the scout's detected env files into the flight's envset, then prove
// config + env together with a single dry-run boot (mode:'boot' run via the
// runs route — admission/collision live there; one boot needs no portify).
// The boot IS this stage's harness predicate: the agent's config draft never
// settles on say-so. Missing env files park on the one checkpoint even
// `--yolo` honors: canary never guesses secrets.

const BOOT_VERIFY_TIMEOUT_MS = 5 * 60 * 1000

interface BootEvidence {
  runId: string
  services: Array<{ name: string; status?: string }>
}

async function bootVerify(
  deps: FlightStageDeps,
  ctx: StageContext,
  feature: string,
  env: string,
): Promise<{ ok: true; evidence: BootEvidence } | { ok: false; error: string; evidence?: BootEvidence }> {
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
      { what: `boot run ${runId}`, timeoutMs: BOOT_VERIFY_TIMEOUT_MS },
    )
    const evidence: BootEvidence = {
      runId,
      services: (manifest?.services ?? []).map((s) => ({ name: s.name, status: s.status })),
    }
    const failedService = evidence.services.find((s) => s.status === 'timeout')
    if (manifest?.status === 'failed' || manifest?.status === 'aborted' || failedService) {
      const boot = manifest?.bootFailure
      return {
        ok: false,
        evidence,
        error: boot
          ? `service "${boot.service}" failed to boot — see ${boot.logPath ?? 'its service log'}`
          : failedService
            ? `service "${failedService.name}" never passed its health check`
            : `boot run ${runId} ended ${manifest?.status}`,
      }
    }
    ctx.appendLog(`[boot-verify] all services ready\n`)
    return { ok: true, evidence }
  } finally {
    await deps.inject({ method: 'POST', url: `/api/runs/${encodeURIComponent(runId)}/abort`, payload: {} }).catch(() => {})
  }
}

export function envCaptureStage(deps: FlightStageDeps): StageAdapter {
  const capture = (ctx: StageContext, feature: string, env: string, files: string[]): StageOutcome | null => {
    if (files.length === 0) return null
    const result = captureFeatureEnvFiles(
      { projectRoot: deps.projectRoot, featuresDir: deps.featuresDir },
      { feature, sources: files.map((sourcePath) => ({ sourcePath, env, confirmOverwrite: true })) },
    )
    if (!result.ok) return { kind: 'failed', error: result.error }
    ctx.appendLog(`[env] captured ${result.captured.length} file(s) into envsets/${env}/\n`)
    publishWorkspaceEvent(deps.workspaceEvents, { type: 'envsets-changed', feature })
    return null
  }

  const captureAndBoot = async (ctx: StageContext, files: string[]): Promise<StageOutcome> => {
    const m = ctx.manifest()
    const failed = capture(ctx, m.feature, m.opts.env, files)
    if (failed) return failed
    const boot = await bootVerify(deps, ctx, m.feature, m.opts.env)
    if (!boot.ok) return { kind: 'failed', error: boot.error }
    return { kind: 'done', evidence: { captured: files.length, boot: boot.evidence } }
  }

  const detectedFiles = (ctx: StageContext): string[] => {
    const scout = ctx.manifest().stages.find((s) => s.key === 'scout')
    const draft = scout?.evidence as ScoutDraft | undefined
    return (draft?.envFiles ?? []).filter((f) => typeof f === 'string')
  }

  return {
    async run(ctx) {
      const files = detectedFiles(ctx)
      const missing = files.filter((f) => !fs.existsSync(f))
      if (missing.length > 0) {
        return {
          kind: 'checkpoint',
          checkpoint: {
            kind: 'missing-env',
            message: `${missing.length} env file(s) the app reads do not exist. Provide values (they are written to the missing path, then captured), waive them, or create the files and retry. Canary never guesses secrets.`,
            options: ['retry', 'waive'],
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
  }
}
