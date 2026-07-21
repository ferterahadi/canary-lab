import fs from 'fs'
import path from 'path'
import { readEvaluationExportTask } from '../../../evaluation/logic/evaluation-export-store'
import type { StageAdapter, StageContext, StageOutcome } from '../conductor'
import { pollUntil, type FlightStageDeps } from './context'

// Terminal stage: a flight isn't done at green — it ends by producing the
// evaluation archive through the existing test-review-export engine, so the
// deliverable is run-grounded proof. A failed terminal run exports as-is
// (status preserved, per the PRD). Before the export starts, non-yolo flights
// park on the export-mode checkpoint: `raw` (fast report, no LLM rewrite) vs
// `localized` (an agent rewrites per-test reasoning) — the mode the existing
// engine already supports. Yolo defaults to raw. Harness predicate: the zip
// exists on disk and is linked from the manifest.

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

  const startExport = async (ctx: StageContext, mode: ExportMode): Promise<StageOutcome> => {
    const m = ctx.manifest()
    const runId = m.links?.runId
    if (!runId) return { kind: 'failed', error: 'no run to export — the run stage must settle first' }

    // A REPLAYED answer (resume after a mid-export pause) may find the task
    // this flight already started still running or finished — re-attach
    // instead of producing a duplicate archive.
    const priorTaskId = m.links?.evaluationTaskId
    if (priorTaskId) {
      const prior = readEvaluationExportTask(deps.logsDir, priorTaskId)
      if (prior && prior.status !== 'failed' && !prior.error) {
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
        options: ['raw', 'localized'],
        data: { runId: m.links?.runId },
      },
    }
  }

  return {
    async run(ctx) {
      const m = ctx.manifest()
      // Resume: the archive already exists → done.
      if (m.links?.evaluationZip && fs.existsSync(m.links.evaluationZip)) {
        return { kind: 'done', evidence: { evaluationZip: m.links.evaluationZip, reused: true } }
      }
      if (!m.links?.runId) {
        return { kind: 'failed', error: 'no run to export — the run stage must settle first' }
      }
      if (m.opts.yolo) return startExport(ctx, 'raw')
      return modeCheckpoint(ctx)
    },
    async onCheckpointResponse(ctx, response) {
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
