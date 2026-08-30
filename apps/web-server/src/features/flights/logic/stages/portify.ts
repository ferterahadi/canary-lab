import fs from 'fs'
import { overlayExists } from '../../../portify/logic/runtime/overlay'
import { revertPortification } from '../../../portify/logic/runtime/unportify'
import { publishWorkspaceEvent } from '../../../../shared/workspace-events'
import type { PortifyStageProgress } from '../../../../../../../shared/flights/types'
import type { StageAdapter, StageContext, StageOutcome } from '../conductor'
import { featureDirFor, pollUntil, stageModels, type FlightStageDeps } from './context'
import { editFingerprint } from '../../../portify/logic/runtime/git-ops'
import { isActivePortifyStatus, type PortifyStatus } from '../../../portify/logic/runtime/types'
import { portifyJob } from './stage-jobs'
import { externalWorkCheckpoint, parkedOnExternalWork, rejectStaleSubmit } from './externalizable'
import { CHECKPOINT_OPTIONS, type FlightCheckpoint } from '../types'

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
//
// Parallel setup can begin as soon as Suite setup exists, independently of the
// remaining Flight. When the conductor later reaches this stage it adopts that
// same persistent workflow instead of starting a duplicate. The external
// checkpoint support below is retained only so a Flight persisted before the
// ownership change can still be released, revised, or settled without losing
// its verified workflow.

const PORTIFY_TIMEOUT_MS = 30 * 60 * 1000

interface PortifyView {
  status?: PortifyStatus
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

  // A standalone workflow for this feature that no run() of ours started. It
  // may still be editing/verifying, or already parked for review. Either way it
  // owns the feature's scratch config edit, so the Flight follows THIS one.
  const findReusableWorkflow = async (feature: string): Promise<{ workflowId: string; view: PortifyView } | null> => {
    const resp = await deps.inject({ method: 'GET', url: '/api/portify' })
    if (resp.statusCode >= 300) return null
    const entries = resp.json() as { workflowId?: string; feature?: string; status?: PortifyStatus }[]
    const entry = Array.isArray(entries)
      ? entries.find((candidate) => candidate.feature === feature
        && candidate.status != null
        && isActivePortifyStatus(candidate.status))
      : undefined
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
          // Portify's `verifying` phase is its side-by-side service boot and
          // readiness check; the workflow remains the source of the verdict.
          ctx.setTimingPhase?.(v.status === 'verifying' ? 'service-readiness' : null)
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
        `${note ? `${note}\n\n` : ''}Canary started two copies of the app side by side and both came up. Save these port changes for "${feature}"? ` +
        `Nothing goes into your repos — each run applies the changes to a scratch copy and undoes them afterwards. ` +
        `Request changes to send the agent feedback for another pass. Decline and the changes are thrown away — runs stay one at a time, and a later flight can try again.`,
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
      ? `The revised changes failed the side-by-side check${view.verification?.failureDetail ? ` — ${firstLine(view.verification.failureDetail)}` : ''}. Saving stays blocked until a revision passes — request changes again, or decline.`
      : undefined
    return applyCheckpoint(ctx.manifest().feature, workflowId, view.diff, note)
  }

  // A workflow started by this stage and one adopted from the independent lane
  // finish under the same rules: native/no-edit and yolo save immediately;
  // proposed edits park for review.
  const finishFollow = async (ctx: StageContext, workflowId: string, view: PortifyView): Promise<StageOutcome> => {
    if (view.status === 'ready-to-save') {
      const hasEdits = Boolean(view.diff && view.diff.trim())
      if (!hasEdits || ctx.manifest().opts.yolo) {
        if (!hasEdits) ctx.appendLog('[portify] double-boot passed with zero edits — native port injection\n')
        return saveAndVerify(ctx, workflowId, hasEdits)
      }
    }
    return settleReview(ctx, workflowId, view)
  }

  const followReusableWorkflow = async (
    ctx: StageContext,
    adopted: { workflowId: string; view: PortifyView },
  ): Promise<StageOutcome> => {
    ctx.appendLog(`[portify] adopted independent workflow ${adopted.workflowId}\n`)
    ctx.setProgress({ workflowId: adopted.workflowId } satisfies PortifyStageProgress)
    const view = adopted.view.status === 'ready-to-save'
      ? adopted.view
      : await awaitReview(ctx, adopted.workflowId)
    return finishFollow(ctx, adopted.workflowId, view)
  }

  // Start the workflow and follow it to its first settle/park. Reached only
  // AFTER the portify-gate is answered 'run' (or auto-answered/yolo).
  const startAndFollow = async (ctx: StageContext): Promise<StageOutcome> => {
    const m = ctx.manifest()
    // The flight's stored portify choice rides the start payload; the runner
    // re-normalizes it against ITS picked CLI before it can win over config.
    const models = stageModels(m, 'portify')
    const started = await deps.inject({ method: 'POST', url: '/api/portify', payload: { feature: m.feature, ...(models ? { models } : {}) } })
    const body = started.json() as { workflowId?: string; error?: string }
    if (started.statusCode >= 300 || !body.workflowId) {
      // The independent button and the conductor can cross in the same instant:
      // both see no workflow, then one wins the POST. A 409 is therefore one
      // last adoption probe, not a failed Flight.
      if (started.statusCode === 409) {
        const adopted = await findReusableWorkflow(m.feature)
        if (adopted) return followReusableWorkflow(ctx, adopted)
      }
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

    return finishFollow(ctx, workflowId, await awaitReview(ctx, workflowId))
  }

  /** Park the whole external engagement on ONE checkpoint. The prompt is the
   *  runner's own instructions (the same task the local agent gets); the rounds
   *  ride the standalone tools against `workflowId`, and this park just waits
   *  for "it is ready — check it". */
  const parkExternal = (
    ctx: StageContext,
    workflowId: string,
    instructions: string,
    context: Record<string, unknown>,
    note: string,
  ): StageOutcome =>
    externalWorkCheckpoint(ctx, 'portify', instructions, {
      message:
        `${note}\n\nPort-ify in your own client: edit the worktree paths in context.targets so every listener reads an injected port and declare the matching \`ports\` slots in context.configPath, then drive the standalone loop — submit_external_portify("${workflowId}"), poll get_portify, re-edit on a failed verify. STOP at status "ready-to-save" and respond submit here (no data needed — Canary re-reads the workflow and the overlay mark). Do NOT call save_portify or cancel_portify: this flight owns the save decision. Answer run-internally to hand the whole job to Canary's own agent.`,
      context: { workflowId, ...context },
    })

  /** Parallel setup is server-owned even when earlier thinking stages were
   *  handed to the MCP client. This lets the client surface the Report and end
   *  its turn while the existing persistent Portify workflow continues. */
  const startWorkflow = (ctx: StageContext): Promise<StageOutcome> => startAndFollow(ctx)

  /** Re-park the SAME engagement with a status note — the ask (the workflowId
   *  and the task) has not changed, so the checkpoint is reused wholesale and
   *  keeps its hand-off id (rejectStaleSubmit's rule). */
  const reparkExternal = (ctx: StageContext, checkpoint: FlightCheckpoint, why: string): StageOutcome => {
    ctx.appendLog(`[portify] external submit re-parked — ${why}\n`)
    return { kind: 'checkpoint', checkpoint: { ...checkpoint, data: { ...(checkpoint.data as object), lastRejection: why } } }
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
        `Make "${feature}" safe to run two at a time? An agent changes how each service picks its port, in a scratch copy of ` +
        `your repos, then proves it by starting two copies of the app side by side — a big app can take 30-60+ minutes. If ` +
        `another suite already did this work for the same app, Canary reuses and re-checks it first (the agent only runs when ` +
        `that fails). Skip it and runs go one at a time — a later flight can ask again.`,
      options: [...CHECKPOINT_OPTIONS['portify-gate']],
    },
  })

  // No leading "skipped": the client renders this as `Skipped — ${reason}`, so
  // a reason that repeats the word printed it twice in one sentence.
  const SKIP_REASON = 'runs stay one at a time. A later flight can try again.'

  return {
    // The background workflow, from the id the stage pins as progress the moment
    // it exists — which is why that pin is written at start rather than at
    // settle. portifyJob decides what stopping MEANS per phase: a verified
    // ready-to-save review survives a pause.
    teardown: (ctx) => {
      const stage = ctx.manifest().stages.find((s) => s.key === 'portify')
      const workflowId = (stage?.progress as PortifyStageProgress | undefined)?.workflowId
      return workflowId ? portifyJob(deps, workflowId) : null
    },
    async run(ctx) {
      const m = ctx.manifest()
      if (overlayExists(featureDirFor(deps, m.feature))) {
        return { kind: 'skipped', reason: 'already done — a previous flight proved this app can run two at a time' }
      }

      // Reuse the independent Parallel setup workflow when it started before
      // the conductor reached this stage. Parked reviews survive restarts; an
      // editing/verifying workflow is followed live to its eventual outcome.
      // Starting a second workflow would be rejected and would split the UI's
      // ownership, so the workflow id is pinned to this Flight immediately.
      const adopted = await findReusableWorkflow(m.feature)
      if (adopted) return followReusableWorkflow(ctx, adopted)

      // Yolo skips every ask; otherwise the gate parks (autopilot answers it
      // 'run' automatically, so the default pipeline never stalls here).
      if (m.opts.yolo) return startWorkflow(ctx)
      return gateCheckpoint(m.feature)
    },
    async onCheckpointResponse(ctx, response) {
      // Releasing the external ENGAGEMENT park — the whole multi-round job
      // rides the standalone tools; a submit here means "check the workflow".
      if (parkedOnExternalWork(ctx, 'portify')) {
        const m = ctx.manifest()
        const checkpoint = ctx.manifest().stages.find((s) => s.key === 'portify')!.checkpoint!
        const handOff = (checkpoint.data as { context?: { workflowId?: string } } | undefined)?.context
        const workflowId = handOff?.workflowId
        if (response.choice === 'run-internally') {
          ctx.appendLog('[portify] client handed the job back — running the internal workflow\n')
          if (workflowId) {
            await deps.inject({ method: 'POST', url: `/api/portify/${encodeURIComponent(workflowId)}/cancel`, payload: {} }).catch(() => {})
          }
          return startAndFollow(ctx)
        }
        const stale = rejectStaleSubmit(ctx, 'portify', response)
        if (stale) return stale
        if (!workflowId) return { kind: 'failed', error: 'external portify hand-off lost its workflow id' }
        // The verdict is the workflow record + the overlay mark — never the
        // client's account of what it did.
        const view = await read(workflowId)
        if (view.status === 'ready-to-save') {
          const hasEdits = Boolean(view.diff && view.diff.trim())
          if (!hasEdits || m.opts.yolo) {
            if (!hasEdits) ctx.appendLog('[portify] double-boot passed with zero edits — native port injection\n')
            return saveAndVerify(ctx, workflowId, hasEdits)
          }
          return settleReview(ctx, workflowId, view)
        }
        if (view.status === 'saved') {
          // The client called save_portify despite the instructions — accept the
          // outcome, but on the harness-owned mark, exactly as saveAndVerify does.
          return overlayExists(featureDirFor(deps, m.feature))
            ? { kind: 'done', evidence: { workflowId, edits: Boolean(view.diff) } }
            : { kind: 'failed', error: 'portify saved but the overlay mark is missing' }
        }
        if (view.status === 'failed' || view.status === 'aborted') {
          return { kind: 'failed', error: `portify ${view.status}${view.error ? `: ${view.error}` : ''}` }
        }
        return reparkExternal(ctx, checkpoint, `the workflow is still "${view.status ?? 'starting'}" — keep driving submit_external_portify / get_portify and submit here once it reaches ready-to-save`)
      }
      const stage = ctx.manifest().stages.find((s) => s.key === 'portify')
      const cp = stage?.checkpoint
      if (cp?.kind === 'portify-gate') {
        if (response.choice === 'run') return startWorkflow(ctx)
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
        // New Flight-owned workflows are internal even when earlier thinking
        // stages used an external producer. Read the workflow's persisted owner
        // so pre-change external reviews still reopen in their original client.
        const external = (await read(workflowId)).producer === 'external'
        const revised = await deps.inject({
          method: 'POST',
          url: `/api/portify/${encodeURIComponent(workflowId)}/revise`,
          payload: { feedback, ...(external ? { external: true } : {}) },
        })
        if (revised.statusCode >= 300) {
          // e.g. the server restarted since verification — the worktrees (and
          // the agent session revise resumes) are gone. The verified diff is
          // still saveable; re-park with the reason instead of failing.
          const why = errorBody(revised)
          return applyCheckpoint(ctx.manifest().feature, workflowId, data.diff, `Revise unavailable${why ? ` — ${why}` : ''}. Save or discard.`)
        }
        ctx.appendLog(`[portify] revise requested: ${feedback}\n`)
        if (external) {
          const instructions = (revised.json() as { instructions?: string }).instructions
          return parkExternal(ctx, workflowId, instructions ?? feedback, {}, 'The reviewer requested changes — the workflow is back in your editing window.')
        }
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
        return { kind: 'skipped', reason: 'you declined — the changes were thrown away and runs stay one at a time. A later flight can try again.' }
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
