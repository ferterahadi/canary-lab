import fs from 'fs'
import path from 'path'
import { readEvaluationExportTask } from '../../../evaluation/logic/evaluation-export-store'
import { completeExternalEvaluationExport, createExternalEvaluationExportTask } from '../../../evaluation/logic/external-evaluation-export'
import { buildTestReviewPacket, deterministicEvaluationRewrite } from '../../../evaluation/logic/test-review-export'
import { buildEvaluationRewritePrompt, resolveRewriteOutput } from '../../../evaluation/logic/test-review/rewrite-agent'
import { getRunDetail } from '../../../runs/logic/run-store'
import type { StageAdapter, StageContext, StageOutcome } from '../conductor'
import { pollUntil, type FlightStageDeps } from './context'
import { evaluationExportJob } from './stage-jobs'
import { externalWorkCheckpoint, handsOffToClient, parkedOnExternalWork, rejectStaleSubmit } from './externalizable'
import { CHECKPOINT_OPTIONS } from '../types'
import { externalAgentSessionForFlight } from '../external-agent-session'

// Terminal stage: a flight isn't done at green — it ends by producing the
// evaluation archive through the existing test-review-export engine, so the
// deliverable is run-grounded proof. A failed terminal run exports as-is
// (status preserved, per the PRD). Before the export starts, non-yolo flights
// park on the export-mode checkpoint: `raw` (fast report, no LLM rewrite) vs
// `localized` (an agent rewrites per-test reasoning) — the mode the existing
// engine already supports. Harness predicate: the zip exists on disk and is
// linked from the manifest.
//
// The DEFAULT mode follows the producer (user decision, 2026-08-21): an
// internal flight defaults to `raw` (yolo and autopilot alike); an external
// one defaults to `localized`, because the rewrite is the stage's thinking and
// an external flight wants its thinking external. The explicit checkpoint
// still lets a human pick `raw` either way. Under stageProducer:"external" the
// localized rewrite is handed to the client (the SAME evaluation-rewrite.md
// prompt the internal agent gets); `raw` stays internal and deterministic for
// every producer — there is no thinking in it to move.

const EXPORT_TIMEOUT_MS = 10 * 60 * 1000

type ExportMode = 'raw' | 'localized'

export function evaluationExportStage(deps: FlightStageDeps): StageAdapter {
  const settleTask = async (ctx: StageContext, taskId: string, mode: ExportMode): Promise<StageOutcome> => {
    const task = await pollUntil(
      async () => readEvaluationExportTask(deps.logsDir, taskId),
      (t) => Boolean(t && (t.downloadReady || t.error || t.status === 'failed')),
      { what: `evaluation export ${taskId}`, timeoutMs: EXPORT_TIMEOUT_MS, signal: ctx.signal },
    )
    if (!task?.downloadReady) {
      // pollUntil only settles here when downloadReady is false AND (error is
      // set OR status is 'failed') — so error/status are never both absent.
      return { kind: 'failed', error: `evaluation export failed: ${task?.error ?? task?.status}` }
    }

    const evaluationZip = path.join(deps.logsDir, 'evaluation-exports', taskId, 'export.zip')
    if (!fs.existsSync(evaluationZip)) {
      return { kind: 'failed', error: `export reported ready but no archive at ${evaluationZip}` }
    }
    ctx.patchFlight({ links: { evaluationTaskId: taskId, evaluationZip } })
    return { kind: 'done', evidence: { taskId, evaluationZip, archiveBase: task.archiveBase, mode } }
  }

  /** Hand the localized rewrite to the client: mint (or re-adopt) an EXTERNAL
   *  export task so links/cleanup/reset behave exactly as for an internal one,
   *  then park with the same rendered prompt the internal rewrite agent gets. */
  const handOffLocalized = async (ctx: StageContext, runId: string, lastRejection?: string): Promise<StageOutcome> => {
    const m = ctx.manifest()
    const detail = getRunDetail(deps.logsDir, runId)
    if (!detail) return { kind: 'failed', error: `run ${runId} has no manifest — nothing to export` }

    // Re-adopt the task a previous park of THIS flight minted (resume/re-park),
    // instead of littering one record per park.
    const priorTaskId = m.links?.evaluationTaskId
    let task = priorTaskId ? readEvaluationExportTask(deps.logsDir, priorTaskId) : null
    if (task && (task.producer !== 'external' || task.status === 'failed' || task.error)) task = null
    if (task?.downloadReady) return settleTask(ctx, task.taskId, 'localized')
    if (!task) {
      const session = externalAgentSessionForFlight(m)
      task = createExternalEvaluationExportTask({
        logsDir: deps.logsDir,
        detail,
        sessionId: session.sessionId,
        clientKind: session.clientKind,
        ...(session.conversationName ? { conversationName: session.conversationName } : {}),
        ...(session.sessionUrl ? { sessionUrl: session.sessionUrl } : {}),
      })
      // Linked at CREATION, like the internal path — a pause/crash mid-hand-off
      // must leave the pointer behind for the re-adopt above.
      ctx.patchFlight({ links: { evaluationTaskId: task.taskId } })
      ctx.appendLog(`[export] external evaluation task ${task.taskId} created (localized)\n`)
    }

    const packet = buildTestReviewPacket(detail)
    const fallback = deterministicEvaluationRewrite(packet)
    ctx.appendLog(lastRejection
      ? `[export] external rewrite rejected — ${lastRejection}\n`
      : '[export] localized rewrite handed off to the external agent session\n')
    return externalWorkCheckpoint(ctx, 'evaluation-export', buildEvaluationRewritePrompt(packet, fallback), {
      message: lastRejection
        ? `That rewrite was rejected: ${lastRejection}. Answer again with the shape the prompt asks for — or "run-internally" to hand the step to Canary's own agent.`
        : 'Rewrite the evaluation wording in your own client following the prompt, then respond with its answer on `data` — { slots: [...] } (preferred: the case roster stays intact by construction) or the full { cases: [...] } envelope. Canary renders the final evaluation.html itself; a failed run\'s status is preserved, never softened.',
      context: {
        taskId: task.taskId,
        runId,
        caseCount: packet.tests.length,
        ...(lastRejection === undefined ? {} : { lastRejection }),
      },
    })
  }

  const startExport = async (ctx: StageContext, mode: ExportMode, opts: { forceInternal?: boolean } = {}): Promise<StageOutcome> => {
    const m = ctx.manifest()
    const runId = m.links?.runId
    if (!runId) return { kind: 'failed', error: 'no run to export — the run stage must settle first' }

    // The localized rewrite is thinking; under an external producer it is the
    // client's — unless the client just handed it back (forceInternal).
    if (mode === 'localized' && !opts.forceInternal && handsOffToClient(ctx)) {
      return handOffLocalized(ctx, runId)
    }

    // A REPLAYED answer (resume after a mid-export pause) may find the task
    // this flight already started still running or finished — re-attach
    // instead of producing a duplicate archive. An unfinished EXTERNAL task is
    // the exception: nobody local will ever complete it, so a forced-internal
    // export starts fresh rather than dead-waiting on it (the abandoned record
    // stays for Log Cleanup).
    const priorTaskId = m.links?.evaluationTaskId
    if (priorTaskId) {
      const prior = readEvaluationExportTask(deps.logsDir, priorTaskId)
      if (prior && prior.status !== 'failed' && !prior.error && ((prior.producer ?? 'internal') === 'internal' || prior.downloadReady)) {
        ctx.appendLog(`[export] re-attaching to export task ${priorTaskId}\n`)
        return settleTask(ctx, priorTaskId, mode)
      }
    }

    const started = await deps.inject({
      method: 'POST',
      url: `/api/runs/${encodeURIComponent(runId)}/evaluation-export`,
      payload: { mode },
    })
    const body = started.json() as { taskId?: string; error?: string }
    if (started.statusCode !== 202 || !body.taskId) {
      return { kind: 'failed', error: `evaluation export rejected (${started.statusCode}): ${body.error ?? 'unknown'}` }
    }
    const taskId = body.taskId
    // Linked at START, not completion — a pause/crash mid-export must leave
    // the pointer behind for the replay above to re-attach to.
    ctx.patchFlight({ links: { evaluationTaskId: taskId } })
    ctx.appendLog(`[export] evaluation export task ${taskId} started (${mode})\n`)
    return settleTask(ctx, taskId, mode)
  }

  const modeCheckpoint = (ctx: StageContext): StageOutcome => {
    const m = ctx.manifest()
    return {
      kind: 'checkpoint',
      checkpoint: {
        kind: 'export-mode',
        message: `How should the evaluation for "${m.feature}" be written? raw = fast report straight from the run evidence; localized = an agent rewrites the per-test reasoning for readability (slower).`,
        options: [...CHECKPOINT_OPTIONS['export-mode']],
        data: { runId: m.links?.runId },
      },
    }
  }

  return {
    // The export task, from the link pinned at START (not completion) — the same
    // pointer the re-attach path reads.
    teardown: (ctx) => {
      const taskId = ctx.manifest().links?.evaluationTaskId
      return taskId ? evaluationExportJob(deps, taskId) : null
    },
    async run(ctx) {
      const m = ctx.manifest()
      // Resume: the archive already exists → done.
      if (m.links?.evaluationZip && fs.existsSync(m.links.evaluationZip)) {
        return { kind: 'done', evidence: { evaluationZip: m.links.evaluationZip, reused: true } }
      }
      if (!m.links?.runId) {
        return { kind: 'failed', error: 'no run to export — the run stage must settle first' }
      }
      // Yolo skips the ASK, not the work: scout and specs-coverage already park
      // their hand-offs under yolo+external, so the export's default mode does
      // the same — external defaults to the localized hand-off, internal to raw.
      if (m.opts.yolo) return startExport(ctx, handsOffToClient(ctx) ? 'localized' : 'raw')
      return modeCheckpoint(ctx)
    },
    async onCheckpointResponse(ctx, response) {
      // Releasing the localized hand-off, not the export-mode question.
      if (parkedOnExternalWork(ctx, 'evaluation-export')) {
        const m = ctx.manifest()
        const runId = m.links?.runId
        if (!runId) return { kind: 'failed', error: 'no run to export — the run stage must settle first' }
        if (response.choice === 'run-internally') {
          ctx.appendLog('[export] client handed the localized rewrite back — running it here\n')
          return startExport(ctx, 'localized', { forceInternal: true })
        }
        const stale = rejectStaleSubmit(ctx, 'evaluation-export', response)
        if (stale) return stale
        const handOff = m.stages.find((s) => s.key === 'evaluation-export')?.checkpoint?.data as
          | { context?: { taskId?: string } }
          | undefined
        const taskId = handOff?.context?.taskId
        if (!taskId) return { kind: 'failed', error: 'external evaluation hand-off lost its task id' }
        const detail = getRunDetail(deps.logsDir, runId)
        if (!detail) return { kind: 'failed', error: `run ${runId} has no manifest — nothing to export` }
        const packet = buildTestReviewPacket(detail)
        const fallback = deterministicEvaluationRewrite(packet)
        // The SAME parse chain the internal agent's output goes through — a
        // structured object submission is stringified into it, so one resolver
        // judges both producers and both answer forms.
        const output = typeof response.data === 'string' ? response.data : JSON.stringify(response.data ?? '')
        const rewrite = resolveRewriteOutput(output, packet, fallback)
        if (!rewrite) {
          return handOffLocalized(ctx, runId,
            `the submission was not a usable rewrite — reply with { slots: [...] } (preferred) or a full { cases: [...] } envelope carrying exactly ${packet.tests.length} case(s) in the given order`)
        }
        const completed = await completeExternalEvaluationExport({ logsDir: deps.logsDir, detail, taskId, rewrite })
        if (!completed.ok) return { kind: 'failed', error: completed.error }
        // Harness predicate: the zip on disk, linked from the manifest — the
        // same settle the internal producer goes through.
        return settleTask(ctx, taskId, 'localized')
      }
      const choice = response.choice ?? ''
      if (choice === 'raw' || choice === 'localized') return startExport(ctx, choice)
      return modeCheckpoint(ctx)
    },
    // R78 restart wipe: drop the export task dir (export.zip included) through
    // the evaluation route — it aborts a still-running task and emits the
    // evaluation-export-deleted event. The run record is the RUN stage's
    // artifact; a restart entering here keeps it (it is this stage's input).
    async reset(ctx) {
      const taskId = ctx.manifest().links?.evaluationTaskId
      if (!taskId) return
      await deps
        .inject({ method: 'DELETE', url: `/api/evaluation-exports/${encodeURIComponent(taskId)}` })
        .catch(() => {})
    },
  }
}
