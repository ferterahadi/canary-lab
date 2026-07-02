import fs from 'fs'
import path from 'path'
import { readEvaluationExportTask } from '../../../evaluation/logic/evaluation-export-store'
import type { StageAdapter } from '../conductor'
import { pollUntil, type FlightStageDeps } from './context'

// Terminal stage: a flight isn't done at green — it ends by producing the
// evaluation archive through the existing test-review-export engine, so the
// deliverable is run-grounded proof. A failed terminal run exports as-is
// (status preserved, per the PRD). Harness predicate: the zip exists on disk
// and is linked from the manifest.

const EXPORT_TIMEOUT_MS = 10 * 60 * 1000

export function evaluationExportStage(deps: FlightStageDeps): StageAdapter {
  return {
    async run(ctx) {
      const m = ctx.manifest()
      // Resume: the archive already exists → done.
      if (m.links?.evaluationZip && fs.existsSync(m.links.evaluationZip)) {
        return { kind: 'done', evidence: { evaluationZip: m.links.evaluationZip, reused: true } }
      }
      const runId = m.links?.runId
      if (!runId) return { kind: 'failed', error: 'no run to export — the run stage must settle first' }

      const started = await deps.inject({
        method: 'POST',
        url: `/api/runs/${encodeURIComponent(runId)}/evaluation-export`,
        payload: { mode: 'raw' },
      })
      const body = started.json() as { taskId?: string; error?: string }
      if (started.statusCode !== 202 || !body.taskId) {
        return { kind: 'failed', error: `evaluation export rejected (${started.statusCode}): ${body.error ?? 'unknown'}` }
      }
      const taskId = body.taskId
      ctx.appendLog(`[export] evaluation export task ${taskId} started\n`)

      const task = await pollUntil(
        async () => readEvaluationExportTask(deps.logsDir, taskId),
        (t) => Boolean(t && (t.downloadReady || t.error || t.status === 'failed')),
        { what: `evaluation export ${taskId}`, timeoutMs: EXPORT_TIMEOUT_MS },
      )
      if (!task?.downloadReady) {
        return { kind: 'failed', error: `evaluation export failed: ${task?.error ?? task?.status ?? 'unknown'}` }
      }

      const evaluationZip = path.join(deps.logsDir, 'evaluation-exports', taskId, 'export.zip')
      if (!fs.existsSync(evaluationZip)) {
        return { kind: 'failed', error: `export reported ready but no archive at ${evaluationZip}` }
      }
      ctx.patchFlight({ links: { evaluationTaskId: taskId, evaluationZip } })
      return { kind: 'done', evidence: { taskId, evaluationZip, archiveBase: task.archiveBase } }
    },
  }
}
