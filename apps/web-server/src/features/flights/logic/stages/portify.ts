import fs from 'fs'
import { overlayExists } from '../../../portify/logic/runtime/overlay'
import { revertPortification } from '../../../portify/logic/runtime/unportify'
import { publishWorkspaceEvent } from '../../../../shared/workspace-events'
import type { PortifyStageProgress } from '../../../../../../../shared/flights/types'
import type { StageAdapter, StageContext, StageOutcome } from '../conductor'
import { featureDirFor, pollUntil, type FlightStageDeps } from './context'
import { editFingerprint } from '../../../portify/logic/runtime/git-ops'
import { CHECKPOINT_OPTIONS } from '../types'

// Port-ification runs by default — every flight attempts to leave the feature
// concurrency-ready. The stage drives the existing portify background job
// (agent + ephemeral overlay + double-boot verify); the double-boot verify is
// the success predicate and earns the on-disk "portified" mark
// (features/<f>/portify/meta.json). Three skips exist: the mark already
// existing; the human answering the UPFRONT portify-gate with 'skip' (before
// any agent/boot cost); and the human DECLINING the verified diff at the
// review checkpoint. In every skip the feature stays serial and the next
// flight retries — skipping is a decision, not a failure. A natively
// port-injectable service is the fast path through the stage (double-boot
// passes with zero edits, no review needed), not a skip.

const PORTIFY_TIMEOUT_MS = 30 * 60 * 1000

interface PortifyView {
  status?: string
  attempt?: number
  maxAttempts?: number
  diff?: string
  error?: string
  /** `external` means the user's own client holds the editing window. */
  producer?: string
  /** Scratch worktrees, read for the edit fingerprint during external editing. */
  repos?: Array<{ worktreePath?: string }>
  /** Set by this stage's own poll, not by the server — see awaitReview. */
  editDigest?: string
  /** Double-boot outcome of the LATEST pass — a revise re-parks at
   *  ready-to-save even when its re-verify failed (save is then blocked). */
  verification?: { ok?: boolean; failureDetail?: string }
}

export function portifyStage(deps: FlightStageDeps): StageAdapter {
  const read = async (workflowId: string): Promise<PortifyView> => {
    const resp = await deps.inject({ method: 'GET', url: `/api/portify/${encodeURIComponent(workflowId)}` })
    return resp.json() as PortifyView
  }

  // A ready-to-save workflow for this feature that no run() of ours started —
  // i.e. a review verified before a server restart (kept answerable by the
  // startup reclaim) or an open wizard review. Either way it owns the
  // feature's in-place config edit, so a new workflow is inadmissible and the
  // stage parks on THIS one.
  const findParkedReview = async (feature: string): Promise<{ workflowId: string; view: PortifyView } | null> => {
    const resp = await deps.inject({ method: 'GET', url: '/api/portify' })
    if (resp.statusCode >= 300) return null
    const entries = resp.json() as { workflowId?: string; feature?: string; status?: string }[]
    const entry = Array.isArray(entries) ? entries.find((e) => e.feature === feature && e.status === 'ready-to-save') : undefined
    if (!entry?.workflowId) return null
    return { workflowId: entry.workflowId, view: await read(entry.workflowId) }
  }

  const saveAndVerify = async (ctx: StageContext, workflowId: string, hadEdits: boolean): Promise<StageOutcome> => {
    const saved = await deps.inject({ method: 'POST', url: `/api/portify/${encodeURIComponent(workflowId)}/save`, payload: {} })
    if (saved.statusCode >= 300) {
      // Carry the server's reason — a bare status code ("save rejected (409)")
      // hides WHY (e.g. `cannot save a workflow in status "aborted"` after a
      // restart orphaned the workflow) and leaves the user guessing.
      const why = errorBody(saved)
      return { kind: 'failed', error: `portify save rejected (${saved.statusCode})${why ? `: ${why}` : ''}` }
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

  // Follow the workflow (initial run OR a revise pass) until it parks or
  // settles, mirroring its live phase into stage progress — but only on
  // change; a manifest write per 3s poll would be churn. Feeds the flight
  // view's attempt stepper + phase verb.
  const awaitReview = async (ctx: StageContext, workflowId: string): Promise<PortifyView> => {
    let publishedPhase = ''
    let publishedEdits = ''
    return pollUntil(
      async () => {
        const v = await read(workflowId)
        // While an EXTERNAL client holds the editing window, `status` and `attempt`
        // are both pinned — nothing server-side is advancing. Read the worktree
        // instead so the liveness key tracks real edits. Without this the
        // 30-minute IDLE budget expires on a client that is still working and the
        // stage abandons a live workflow — orphaning it exactly as the old
        // fixed-wall-clock version did to slow double-boots.
        // No .catch here on purpose: editFingerprint cannot reject — runGit only
        // ever resolves (never rejects) and its stat lookups are already guarded —
        // so a catch arm would be untestable defensive code.
        const edits = v.status === 'editing' && v.producer === 'external' && v.repos
          ? await editFingerprint(v.repos)
          : null
        const phase = `${v.status ?? ''}#${v.attempt ?? ''}`
        if (phase !== publishedPhase || (edits !== null && edits.digest !== publishedEdits)) {
          publishedPhase = phase
          publishedEdits = edits?.digest ?? ''
          ctx.setProgress({
            workflowId,
            ...(v.status ? { status: v.status } : {}),
            ...(v.attempt != null ? { attempt: v.attempt } : {}),
            ...(v.maxAttempts != null ? { maxAttempts: v.maxAttempts } : {}),
            ...(edits === null ? {} : { editedFiles: edits.files }),
          } satisfies PortifyStageProgress)
        }
        // Carried on the polled value so progressKey below can see it — the poll
        // helper only ever compares what `read` returns.
        return { ...v, editDigest: edits?.digest ?? '' }
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
        // The edit digest is the ONLY component that moves during an external
        // editing window; status/attempt cover every other phase.
        // editDigest is always a string here — the reader above sets it on every
        // poll — so it needs no fallback.
        progressKey: (v) => `${v.status ?? ''}#${v.attempt ?? ''}#${v.editDigest}`,
      },
    )
  }

  // The parked-review checkpoint. "Save", not "apply": answering 'apply'
  // PERSISTS the verified diff as the feature's overlay — nothing is applied
  // to the product repos now. Runs apply the overlay into per-run worktrees at
  // boot and reverse it at teardown; the repos stay pristine. `note` prefixes
  // a re-park with what just happened (a failed re-verify, an unavailable
  // revise) so the user answers with the full picture.
  const applyCheckpoint = (feature: string, workflowId: string, diff: string | undefined, note?: string): StageOutcome => ({
    kind: 'checkpoint',
    checkpoint: {
      kind: 'portify-apply',
      message:
        `${note ? `${note}\n\n` : ''}Portify verified these edits with a concurrent double-boot. Save them as "${feature}"'s overlay? ` +
        `Nothing lands in your repos — runs apply the overlay into a throwaway per-run worktree at boot and reverse it at teardown. ` +
        `Request changes to send feedback back to the agent for another edit + re-verify pass. Declining discards the edits and SKIPS parallel readiness — the feature stays serial (runs go one at a time) and a later flight can retry.`,
      options: [...CHECKPOINT_OPTIONS['portify-apply']],
      data: { workflowId, diff },
    },
  })

  // Shared post-poll settling for run() and a revise pass: terminal statuses
  // fail/save; ready-to-save re-parks the checkpoint.
  const settleReview = async (ctx: StageContext, workflowId: string, view: PortifyView): Promise<StageOutcome> => {
    if (view.status === 'failed' || view.status === 'aborted') {
      return { kind: 'failed', error: `portify ${view.status}${view.error ? `: ${view.error}` : ''}` }
    }
    if (view.status === 'saved') return saveAndVerify(ctx, workflowId, Boolean(view.diff))
    // A revise whose re-verify FAILED still re-parks at ready-to-save (the
    // last good diff stays reviewable) but save is blocked server-side —
    // lead the checkpoint with that verdict so "Save" isn't a dead button.
    const failedVerify = view.verification && view.verification.ok === false
    const note = failedVerify
      ? `The revised edits FAILED the double-boot re-verify${view.verification?.failureDetail ? ` — ${firstLine(view.verification.failureDetail)}` : ''}. Saving is blocked until a revise passes; request changes again or discard.`
      : undefined
    return applyCheckpoint(ctx.manifest().feature, workflowId, view.diff, note)
  }

  // Start the workflow and follow it to its first settle/park. Reached only
  // AFTER the portify-gate is answered 'run' (or auto-answered/yolo).
  const startAndFollow = async (ctx: StageContext): Promise<StageOutcome> => {
    const m = ctx.manifest()
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

    const view = await awaitReview(ctx, workflowId)
    if (view.status === 'ready-to-save') {
      const hasEdits = Boolean(view.diff && view.diff.trim())
      if (!hasEdits || m.opts.yolo) {
        if (!hasEdits) ctx.appendLog('[portify] double-boot passed with zero edits — native port injection\n')
        return saveAndVerify(ctx, workflowId, hasEdits)
      }
    }
    return settleReview(ctx, workflowId, view)
  }

  // The upfront ask, BEFORE any worktree/agent/double-boot cost is spent.
  // Autopilot answers 'run' (the pipeline default); with autopilot off — or on
  // an explicitly re-entered stage — the human gets the skip here instead of
  // discovering it 45 minutes later on the review checkpoint.
  const gateCheckpoint = (feature: string): StageOutcome => ({
    kind: 'checkpoint',
    checkpoint: {
      kind: 'portify-gate',
      message:
        `Make "${feature}" parallel-ready? An agent rewrites its port wiring in a throwaway worktree and proves it with a ` +
        `concurrent double-boot — heavy stacks can take 30-60+ minutes. If a sibling feature already portified the same app, ` +
        `its overlay is reused and verified FIRST (the agent only runs if that fails). Skipping keeps the feature serial — ` +
        `runs go one at a time — and a later flight can ask again.`,
      options: [...CHECKPOINT_OPTIONS['portify-gate']],
    },
  })

  const SKIP_REASON = 'parallel readiness skipped — the feature stays serial (runs go one at a time). A later flight or the Features-page portify can retry.'

  return {
    async run(ctx) {
      const m = ctx.manifest()
      if (overlayExists(featureDirFor(deps, m.feature))) {
        return { kind: 'skipped', reason: 'already portified (double-boot verified by a prior flight/portify)' }
      }

      // Re-adopt a review parked across a server restart: reclaim keeps a
      // verified ready-to-save workflow answerable (save works from its
      // persisted capture), and starting a NEW workflow while it exists is
      // rejected — so park this stage straight onto it instead of failing.
      const adopted = await findParkedReview(m.feature)
      if (adopted) {
        ctx.appendLog(`[portify] re-adopted parked workflow ${adopted.workflowId} (verified before a server restart)\n`)
        ctx.setProgress({ workflowId: adopted.workflowId } satisfies PortifyStageProgress)
        return settleReview(ctx, adopted.workflowId, adopted.view)
      }

      // Yolo skips every ask; otherwise the gate parks (autopilot answers it
      // 'run' automatically, so the default pipeline never stalls here).
      if (m.opts.yolo) return startAndFollow(ctx)
      return gateCheckpoint(m.feature)
    },
    async onCheckpointResponse(ctx, response) {
      const stage = ctx.manifest().stages.find((s) => s.key === 'portify')
      const cp = stage?.checkpoint
      if (cp?.kind === 'portify-gate') {
        if (response.choice === 'run') return startAndFollow(ctx)
        if (response.choice === 'skip') return { kind: 'skipped', reason: SKIP_REASON }
        // Unknown (e.g. a stale replayed 'apply' from an older park) → re-ask.
        return { kind: 'checkpoint', checkpoint: cp }
      }
      const data = cp?.data as { workflowId?: string; diff?: string } | undefined
      if (!data?.workflowId) return this.run!(ctx)
      const workflowId = data.workflowId
      if (response.choice === 'apply') {
        const outcome = await saveAndVerify(ctx, workflowId, true)
        if (outcome.kind === 'failed' && saveHitDeadWorkflow(outcome.error)) {
          // The answer points at a workflow that no longer exists — e.g. a
          // resume REPLAYED the stored 'apply' after a restart aborted the
          // workflow (pre-capture records). Retrying the save can never
          // succeed; fall back to a fresh run(), which re-adopts a kept
          // parked review when one exists and starts a new workflow otherwise.
          ctx.appendLog(`[portify] stored answer targets a dead workflow (${workflowId}) — re-running the stage\n`)
          return this.run!(ctx)
        }
        return outcome
      }
      if (response.choice === 'revise') {
        const feedback = response.feedback?.trim()
        if (!feedback) {
          return applyCheckpoint(ctx.manifest().feature, workflowId, data.diff, 'Request changes needs feedback text — say what to change.')
        }
        const revised = await deps.inject({ method: 'POST', url: `/api/portify/${encodeURIComponent(workflowId)}/revise`, payload: { feedback } })
        if (revised.statusCode >= 300) {
          // e.g. the server restarted since verification — the worktrees (and
          // the agent session revise resumes) are gone. The verified diff is
          // still saveable; re-park with the reason instead of failing.
          const why = errorBody(revised)
          return applyCheckpoint(ctx.manifest().feature, workflowId, data.diff, `Revise unavailable${why ? ` — ${why}` : ''}. Save or discard.`)
        }
        ctx.appendLog(`[portify] revise requested: ${feedback}\n`)
        const view = await awaitReview(ctx, workflowId)
        return settleReview(ctx, workflowId, view)
      }
      if (response.choice === 'cancel') {
        await deps.inject({ method: 'POST', url: `/api/portify/${encodeURIComponent(workflowId)}/cancel`, payload: {} }).catch(() => {})
        // Declining is a decision, not a failure — the flight proceeds WITHOUT
        // parallel readiness. Failing here was a dead end: the only "retry"
        // was re-running the same 45-minute workflow the user just rejected.
        // The feature simply stays serial (exactly its pre-portify state; runs
        // still work on the real path, one at a time), and with no overlay
        // mark the next flight/redo attempts portify again.
        return { kind: 'skipped', reason: 'declined — edits discarded; the feature stays serial (not concurrency-ready). A later flight or the Features-page portify can retry.' }
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

/** A save rejection that can NEVER succeed on retry: the workflow is gone
 *  (terminal, deleted, or its worktrees died with a restart and no capture
 *  exists). Matches the runner's own error strings — same repo, kept in step
 *  by the stage tests. */
function saveHitDeadWorkflow(error: string): boolean {
  return /cannot save a workflow in status "(aborted|failed)"|workflow not found|worktree is no longer available/.test(error)
}

/** The `{ error }` body every portify route returns on a non-2xx. */
function errorBody(resp: { json: () => unknown }): string | null {
  try {
    const b = resp.json() as { error?: unknown } | null
    return b && typeof b.error === 'string' && b.error ? b.error : null
  } catch {
    return null
  }
}

function firstLine(s: string): string {
  // `split` always yields at least one element, so index 0 is never undefined.
  return s.split('\n', 1)[0]
}
