import fs from 'fs'
import { overlayExists } from '../../../portify/logic/runtime/overlay'
import { revertPortification } from '../../../portify/logic/runtime/unportify'
import { publishWorkspaceEvent } from '../../../../shared/workspace-events'
import type { PortifyStageProgress } from '../../../../../../../shared/flights/types'
import type { StageAdapter, StageContext, StageOutcome } from '../conductor'
import { featureDirFor, pollUntil, type FlightStageDeps } from './context'

// Port-ification ALWAYS runs — every flight leaves the feature
// concurrency-ready. The stage drives the existing portify background job
// (agent + ephemeral overlay + double-boot verify); the double-boot verify is
// the success predicate and earns the on-disk "portified" mark
// (features/<f>/portify/meta.json). The ONLY skip is that mark already
// existing. A natively port-injectable service is the fast path through the
// stage (double-boot passes with zero edits, no review needed), not a skip.

const PORTIFY_TIMEOUT_MS = 30 * 60 * 1000

interface PortifyView {
  status?: string
  attempt?: number
  maxAttempts?: number
  diff?: string
  error?: string
}

export function portifyStage(deps: FlightStageDeps): StageAdapter {
  const read = async (workflowId: string): Promise<PortifyView> => {
    const resp = await deps.inject({ method: 'GET', url: `/api/portify/${encodeURIComponent(workflowId)}` })
    return resp.json() as PortifyView
  }

  const saveAndVerify = async (ctx: StageContext, workflowId: string, hadEdits: boolean): Promise<StageOutcome> => {
    const saved = await deps.inject({ method: 'POST', url: `/api/portify/${encodeURIComponent(workflowId)}/save`, payload: {} })
    if (saved.statusCode >= 300) {
      return { kind: 'failed', error: `portify save rejected (${saved.statusCode})` }
    }
    await pollUntil(() => read(workflowId), (v) => v.status === 'saved' || v.status === 'failed' || v.status === 'aborted', {
      what: `portify ${workflowId} save`,
      timeoutMs: 60_000,
    })
    // The harness-owned mark, not the workflow's word for it.
    const featureDir = featureDirFor(deps, ctx.manifest().feature)
    if (!overlayExists(featureDir)) {
      return { kind: 'failed', error: 'portify saved but the overlay mark is missing' }
    }
    return { kind: 'done', evidence: { workflowId, edits: hadEdits } }
  }

  return {
    async run(ctx) {
      const m = ctx.manifest()
      if (overlayExists(featureDirFor(deps, m.feature))) {
        return { kind: 'skipped', reason: 'already portified (double-boot verified by a prior flight/portify)' }
      }

      const started = await deps.inject({ method: 'POST', url: '/api/portify', payload: { feature: m.feature } })
      const body = started.json() as { workflowId?: string; error?: string }
      if (started.statusCode >= 300 || !body.workflowId) {
        return { kind: 'failed', error: `portify start rejected (${started.statusCode}): ${body.error ?? 'unknown'}` }
      }
      const workflowId = body.workflowId
      ctx.appendLog(`[portify] workflow ${workflowId} started\n`)
      // Pin the workflow id as live progress the moment it exists — the agent
      // editing phase runs for many minutes, and the flight view tails the
      // workflow's agent session (the embedded timeline) DURING it, not only
      // after saveAndVerify settles it into evidence. The same pin lets a
      // stage parked mid-step (pause / checkpoint) still open its workflow
      // via the drill-through (see PortifyStageProgress).
      ctx.setProgress({ workflowId } satisfies PortifyStageProgress)

      // Mirror the workflow's live phase into the same progress shape, but only
      // when it changes — a manifest write per 3s poll would be churn. Feeds
      // the flight view's attempt stepper + phase verb.
      let publishedPhase = ''
      const view = await pollUntil(
        async () => {
          const v = await read(workflowId)
          const phase = `${v.status ?? ''}#${v.attempt ?? ''}`
          if (phase !== publishedPhase) {
            publishedPhase = phase
            ctx.setProgress({
              workflowId,
              ...(v.status ? { status: v.status } : {}),
              ...(v.attempt != null ? { attempt: v.attempt } : {}),
              ...(v.maxAttempts != null ? { maxAttempts: v.maxAttempts } : {}),
            } satisfies PortifyStageProgress)
          }
          return v
        },
        (v) => v.status === 'ready-to-save' || v.status === 'saved' || v.status === 'failed' || v.status === 'aborted',
        {
          what: `portify ${workflowId}`,
          intervalMs: 3000,
          timeoutMs: PORTIFY_TIMEOUT_MS,
          signal: ctx.signal,
          // IDLE budget, not wall-clock: a legitimate multi-attempt double-boot
          // of heavy Gradle apps outruns any fixed cap (a passing 2-attempt run
          // took 45m while this was 30m wall-clock — the stage abandoned a
          // workflow that then SUCCEEDED, orphaned and unsaveable). The phase
          // key mirrors the progress the stage already publishes; a hung
          // workflow freezes it and still dies after PORTIFY_TIMEOUT_MS.
          progressKey: (v) => `${v.status ?? ''}#${v.attempt ?? ''}`,
        },
      )
      if (view.status === 'failed' || view.status === 'aborted') {
        return { kind: 'failed', error: `portify ${view.status}${view.error ? `: ${view.error}` : ''}` }
      }
      if (view.status === 'saved') return saveAndVerify(ctx, workflowId, Boolean(view.diff))

      const hasEdits = Boolean(view.diff && view.diff.trim())
      if (!hasEdits || m.opts.yolo) {
        if (!hasEdits) ctx.appendLog('[portify] double-boot passed with zero edits — native port injection\n')
        return saveAndVerify(ctx, workflowId, hasEdits)
      }
      return {
        kind: 'checkpoint',
        checkpoint: {
          kind: 'portify-apply',
          message: `Portify proposes code edits so "${m.feature}" honors injected ports (double-boot already verified them). Apply the overlay?`,
          options: ['apply', 'cancel'],
          data: { workflowId, diff: view.diff },
        },
      }
    },
    async onCheckpointResponse(ctx, response) {
      const stage = ctx.manifest().stages.find((s) => s.key === 'portify')
      const data = stage?.checkpoint?.data as { workflowId?: string } | undefined
      if (!data?.workflowId) return this.run!(ctx)
      if (response.choice === 'apply') return saveAndVerify(ctx, data.workflowId, true)
      if (response.choice === 'cancel') {
        await deps.inject({ method: 'POST', url: `/api/portify/${encodeURIComponent(data.workflowId)}/cancel`, payload: {} }).catch(() => {})
        return { kind: 'failed', error: 'portify declined — the feature is not concurrency-ready' }
      }
      return { kind: 'checkpoint', checkpoint: stage!.checkpoint! }
    },
    // R78 restart wipe: the existing un-portify — restore the pre-portify
    // feature.config.cjs from its overlay snapshot and drop features/<f>/portify/.
    async reset(ctx) {
      const featureDir = featureDirFor(deps, ctx.manifest().feature)
      if (!fs.existsSync(featureDir) || !overlayExists(featureDir)) return
      revertPortification(featureDir)
      publishWorkspaceEvent(deps.workspaceEvents, { type: 'features-changed' })
    },
  }
}
