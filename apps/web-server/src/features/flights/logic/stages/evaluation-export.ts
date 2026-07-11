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
  const startExport = async (ctx: StageContext, mode: ExportMode): Promise<StageOutcome> => {
    const m = ctx.manifest()
    const runId = m.links?.runId
    if (!runId) return { kind: 'failed', error: 'no run to export — the run stage must settle first' }

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
    ctx.appendLog(`[export] evaluation export task ${taskId} started (${mode})\n`)

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
  }
}
