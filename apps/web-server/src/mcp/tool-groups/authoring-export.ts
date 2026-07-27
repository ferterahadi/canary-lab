// MCP tools — the externally-authored evaluation export lifecycle.
// Split out of authoring.ts; bodies are unchanged.
import { z } from 'zod'
import fs from 'fs'
import path from 'path'
import {
  appendEvaluationExportLog,
  createEvaluationExportTask,
  deleteEvaluationExportTask,
  evaluationExportTaskView,
  listEvaluationExportTasks,
  patchEvaluationExportTask,
  readEvaluationExportTask,
  readEvaluationExportZip,
  writeEvaluationExportZip,
  type EvaluationExportTaskRecord,
} from '../../features/evaluation/logic/evaluation-export-store'
import { buildEvaluationExportArchive } from '../../features/evaluation/logic/evaluation-export-archive'
import { applyEvaluationTextSlotRewrite, buildTestReviewPacket, deterministicEvaluationRewrite, normalizeEvaluationRewrite, type EvaluationRewrite } from '../../features/evaluation/logic/test-review-export'
import { isTerminalRunStatus } from '../../../../../shared/run-state'
import { publishWorkspaceEvent } from '../../shared/workspace-events'
import { type ToolGroupContext, asJsonResult, asToonResult, errorResult, evaluationRewriteInput, evaluationTextSlotInput, externalEvaluationReportSchema, newEvaluationTaskId, safeFilename } from '../tool-support'

export function registerEvaluationExportTools(ctx: ToolGroupContext): void {
  const { registerTool, deps, clientKindInput } = ctx

  registerTool('start_external_evaluation_export', {
    description: 'Create an evaluation export task for an external client to author. Returns run context plus the report/archive submission schema. Does not start any local LLM.',
    inputSchema: {
      runId: z.string(),
      language: z.string().default('English'),
      session_id: z.string(),
      client_kind: clientKindInput,
      conversation_name: z.string().optional(),
      external_session_url: z.string().optional(),
    },
  }, async ({ runId, language, session_id, client_kind, conversation_name, external_session_url }) => {
    const detail = deps.store.get(runId)
    if (!detail) return errorResult(`run not found: ${runId}`)
    if (!isTerminalRunStatus(detail.manifest.status)) {
      return errorResult('evaluation export is available after the run finishes')
    }
    const now = new Date().toISOString()
    const task: EvaluationExportTaskRecord = {
      taskId: newEvaluationTaskId(),
      runId,
      feature: detail.manifest.feature,
      mode: 'localized',
      producer: 'external',
      status: 'running',
      createdAt: now,
      updatedAt: now,
      downloadReady: false,
      archiveBase: `canary-lab-evaluation-${safeFilename(detail.manifest.feature)}-${safeFilename(runId)}`,
      clientKind: client_kind,
      sessionId: session_id,
      ...(conversation_name ? { conversationName: conversation_name } : {}),
      language,
      ...(external_session_url ? { externalSessionUrl: external_session_url } : {}),
    }
    createEvaluationExportTask(deps.store.logsDir, task)
    appendEvaluationExportLog(deps.store.logsDir, task.taskId, '[evaluation] external export task created\n')
    publishWorkspaceEvent(deps.workspaceEvents, { type: 'evaluation-export-created', task: evaluationExportTaskView(task) })
    return asJsonResult({
      task: evaluationExportTaskView(task),
      reportSchema: externalEvaluationReportSchema(detail),
      runSnapshotVia: `get_run("${runId}")`,
      nextSteps: ['call get_run(runId) if you need the run summary/failures while authoring', 'author structured evaluation wording', 'submit_external_evaluation_export'],
    })
  })

  registerTool('submit_external_evaluation_export', {
    description: 'Render structured external evaluation wording through Canary Lab’s canonical HTML export and mark the task completed.',
    inputSchema: {
      taskId: z.string(),
      textSlots: z.array(evaluationTextSlotInput).optional(),
      rewrite: evaluationRewriteInput.optional(),
    },
  }, async ({ taskId, textSlots, rewrite }) => {
    const task = readEvaluationExportTask(deps.store.logsDir, taskId)
    if (!task) return errorResult(`evaluation export task not found: ${taskId}`)
    if ((task.producer ?? 'internal') !== 'external') return errorResult('only external export tasks can be submitted through this tool')
    if (!rewrite && (!textSlots || textSlots.length === 0)) return errorResult('submit textSlots[] or rewrite')
    const detail = deps.store.get(task.runId)
    if (!detail) return errorResult(`run not found: ${task.runId}`)
    try {
      const packet = buildTestReviewPacket(detail)
      const normalizedRewrite = rewrite
        ? normalizeEvaluationRewrite(rewrite as EvaluationRewrite, packet)
        : applyEvaluationTextSlotRewrite(deterministicEvaluationRewrite(packet), textSlots!)
      if (!normalizedRewrite) {
        const expected = packet.tests.length
        const received = Array.isArray((rewrite as EvaluationRewrite | undefined)?.cases)
          ? (rewrite as EvaluationRewrite).cases.length
          : 0
        return errorResult(
          `rewrite.cases must contain exactly ${expected} ${expected === 1 ? 'entry' : 'entries'} — one per evaluated test, in the same order as reportSchema.rewrite.cases (got ${received}). Do NOT merge, dedupe, or drop skipped or duplicate run entries; every run entry needs its own case. Each case requires title, whatWasChecked, whyItMatters, and confidence (all strings).`,
        )
      }
      const built = await buildEvaluationExportArchive(detail, {
        logsDir: deps.store.logsDir,
        audienceAdapter: 'deterministic',
        rewrite: normalizedRewrite,
      })
      writeEvaluationExportZip(deps.store.logsDir, taskId, built.zip)
      appendEvaluationExportLog(deps.store.logsDir, taskId, '[evaluation] external report submitted\n')
      const next = patchEvaluationExportTask(deps.store.logsDir, taskId, {
        archiveBase: built.archiveBase,
        status: 'completed',
        downloadReady: true,
      })
      if (next) {
        publishWorkspaceEvent(deps.workspaceEvents, { type: 'evaluation-export-updated', task: evaluationExportTaskView(next) })
      }
      return asJsonResult({
        ...evaluationExportTaskView(next!),
        // Compact, chat-ready digest of the rendered evaluation so the agent can
        // relay the result in the conversation instead of only pointing at the
        // UI. Kept small (titles + verdicts, not full flow steps); the full
        // rendered evaluation.html ships via download_evaluation_export.
        evaluation: {
          featureTitle: normalizedRewrite.featureTitle ?? next!.feature,
          summary: normalizedRewrite.summary,
          cases: normalizedRewrite.cases.map((c) => ({ title: c.title, confidence: c.confidence })),
        },
        nextSteps: [
          'Present this evaluation to the user in chat — the featureTitle, the summary, and the per-case title + confidence verdicts. Do not just say it is available in the UI.',
          'download_evaluation_export returns the full rendered evaluation.html archive if the user wants the file.',
        ],
      })
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err))
    }
  })

  registerTool('list_evaluation_exports', {
    description: 'List persisted evaluation export tasks. Returned as a TOON table: a `[N]{col,...}:` header line followed by one comma-separated row per task (quoted cells are JSON-escaped strings).',
    inputSchema: { runId: z.string().optional() },
  }, async ({ runId }) => {
    const tasks = listEvaluationExportTasks(deps.store.logsDir, runId ? { runId } : {})
    return asToonResult(tasks.map(evaluationExportTaskView))
  })

  registerTool('get_evaluation_export', {
    description: 'Fetch one evaluation export task.',
    inputSchema: { taskId: z.string() },
  }, async ({ taskId }) => {
    const task = readEvaluationExportTask(deps.store.logsDir, taskId)
    if (!task) return errorResult(`evaluation export task not found: ${taskId}`)
    return asJsonResult(evaluationExportTaskView(task))
  })

  registerTool('download_evaluation_export', {
    description: 'Return a completed evaluation export archive as base64 for MCP clients.',
    inputSchema: { taskId: z.string() },
  }, async ({ taskId }) => {
    const task = readEvaluationExportTask(deps.store.logsDir, taskId)
    if (!task) return errorResult(`evaluation export task not found: ${taskId}`)
    const zip = task.status === 'completed' ? readEvaluationExportZip(deps.store.logsDir, taskId) : null
    if (!zip) return errorResult('evaluation export is not ready')
    return asJsonResult({
      task: evaluationExportTaskView(task),
      filename: `${task.archiveBase}.zip`,
      archiveBase64: zip.toString('base64'),
    })
  })

  registerTool('delete_evaluation_export', {
    description: 'Delete an evaluation export task and stored archive. Requires confirm: true.',
    inputSchema: { taskId: z.string(), confirm: z.literal(true) },
    annotations: { destructiveHint: true, idempotentHint: false },
  }, async ({ taskId }) => {
    const deleted = deleteEvaluationExportTask(deps.store.logsDir, taskId)
    if (!deleted) return errorResult(`evaluation export task not found: ${taskId}`)
    publishWorkspaceEvent(deps.workspaceEvents, { type: 'evaluation-export-deleted', taskId })
    return asJsonResult({ deleted: true, taskId })
  })
}
