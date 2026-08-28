// MCP tools — the externally-authored evaluation export lifecycle.
// Split out of authoring.ts.
import fs from 'fs'
import path from 'path'
import { z } from 'zod'
import {
  deleteEvaluationExportTask,
  evaluationExportTaskPaths,
  evaluationExportTaskView,
  listEvaluationExportTasks,
  readEvaluationExportTask,
  readEvaluationExportZip,
  type EvaluationExportTaskRecord,
  type EvaluationExportTaskView,
} from '../../features/evaluation/logic/evaluation-export-store'
import { completeExternalEvaluationExport, createExternalEvaluationExportTask } from '../../features/evaluation/logic/external-evaluation-export'
import { applyEvaluationTextSlotRewrite, buildTestReviewPacket, deterministicEvaluationRewrite, normalizeEvaluationRewrite, type EvaluationRewrite } from '../../features/evaluation/logic/test-review-export'
import { isTerminalRunStatus } from '../../../../../shared/run-state'
import { type ToolGroupContext, asJsonResult, asToonResult, errorResult, evaluationRewriteInput, evaluationTextSlotInput, externalEvaluationReportSchema, failureResult, gettingStartedBusyResult } from '../tool-support'

type EvaluationExportToolView = EvaluationExportTaskView & {
  archivePath?: string
  reportInsideArchive?: 'evaluation.html'
}

/** MCP clients run on the same machine as this server, so a completed export's
 *  existing zip is a better hand-off than asking the user to download a second
 *  copy. Only advertise a path that exists; a hand-deleted archive still reads
 *  as completed history, but it is no longer something the user can open. */
function evaluationExportToolView(logsDir: string, task: EvaluationExportTaskRecord): EvaluationExportToolView {
  const view = evaluationExportTaskView(task)
  if (!task.downloadReady) return view
  // Stored task ids pass the store's validator before reaching this helper, so
  // the safe path builder cannot reject this id.
  const paths = evaluationExportTaskPaths(logsDir, task.taskId)!
  if (!fs.existsSync(paths.zipPath)) return view
  return {
    ...view,
    archivePath: path.resolve(paths.zipPath),
    reportInsideArchive: 'evaluation.html',
  }
}

export function registerEvaluationExportTools(ctx: ToolGroupContext): void {
  const { registerTool, deps, clientKindInput } = ctx

  registerTool('start_external_evaluation_export', {
    description: 'Create an evaluation export task for an external agent session to author. Returns run context plus the report/archive submission schema. Does not start any local LLM.',
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
    // A boot session runs no tests and a benchmark is not a suite verdict, so
    // neither has anything to evaluate — "terminal" alone admits both (a fresh
    // workspace even ships an aborted boot run), and exporting one produces a
    // plausible-looking but empty evaluation. Mirrors the GUI gate in App.tsx.
    const executionType = detail.manifest.executionType ?? 'run'
    if (executionType === 'boot' || executionType === 'benchmark') {
      return errorResult(`run ${runId} is a ${executionType} session with no test results — run the suite first (start_run), then export that run`)
    }
    // Getting Started demo tracking: claimed after the gates above so a
    // rejected start never needs releasing; task creation below is synchronous.
    const claim = deps.gettingStartedDemo?.claim('export', detail.manifest.feature) ?? null
    if (claim?.kind === 'busy') return gettingStartedBusyResult(claim)
    // Record shape + persistence shared with the flight's export hand-off.
    const task = createExternalEvaluationExportTask({
      logsDir: deps.store.logsDir,
      detail,
      sessionId: session_id,
      clientKind: client_kind,
      ...(conversation_name ? { conversationName: conversation_name } : {}),
      language,
      ...(external_session_url ? { sessionUrl: external_session_url } : {}),
    })
    if (claim?.kind === 'claimed') deps.gettingStartedDemo?.attach(claim.sessionId, { kind: 'export', id: task.taskId, feature: detail.manifest.feature })
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
    // No `?? 'internal'` default: the store's validator fills `producer` on every
    // record it hands back, so a read task always carries one.
    if (task.producer !== 'external') return errorResult('only external export tasks can be submitted through this tool')
    if (!rewrite && (!textSlots || textSlots.length === 0)) return errorResult('submit textSlots[] or rewrite')
    const detail = deps.store.get(task.runId)
    if (!detail) return errorResult(`run not found: ${task.runId}`)
    try {
      const packet = buildTestReviewPacket(detail)
      // Only the rewrite arm can fail the count check, so the rejection lives
      // inside it: a text-slot submission is applied OVER the deterministic
      // rewrite, so its case list comes from the roster and can never disagree
      // with it. Narrowing on `rewrite` here (rather than reporting a defensive
      // 0) is also what makes `rewrite.cases` a checked read — the input schema
      // requires the array, and a future schema change becomes a compile error.
      let normalizedRewrite: EvaluationRewrite
      if (rewrite) {
        const normalized = normalizeEvaluationRewrite(rewrite as EvaluationRewrite, packet)
        if (!normalized) {
          const expected = packet.tests.length
          const received = rewrite.cases.length
          return errorResult(
            `rewrite.cases must contain exactly ${expected} ${expected === 1 ? 'entry' : 'entries'} — one per evaluated test, in the same order as reportSchema.rewrite.cases (got ${received}). Do NOT merge, dedupe, or drop skipped or duplicate run entries; every run entry needs its own case. Each case requires title, whatWasChecked, whyItMatters, and confidence (all strings).`,
          )
        }
        normalizedRewrite = normalized
      } else {
        normalizedRewrite = applyEvaluationTextSlotRewrite(deterministicEvaluationRewrite(packet), textSlots!)
      }
      // Render + store + complete via the shared path (also the flight's).
      const completed = await completeExternalEvaluationExport({
        logsDir: deps.store.logsDir,
        detail,
        taskId,
        rewrite: normalizedRewrite,
      })
      if (!completed.ok) return errorResult(completed.error)
      return asJsonResult({
        ...evaluationExportToolView(deps.store.logsDir, completed.task),
        // Compact, chat-ready digest of the rendered evaluation so the agent can
        // relay the result in the conversation instead of only pointing at the
        // UI. Kept small (titles + verdicts, not full flow steps); archivePath
        // points at the already-rendered evaluation.html zip on this machine.
        evaluation: {
          featureTitle: normalizedRewrite.featureTitle ?? completed.task.feature,
          summary: normalizedRewrite.summary,
          cases: normalizedRewrite.cases.map((c) => ({ title: c.title, confidence: c.confidence })),
        },
        nextSteps: [
          'Present this evaluation to the user in chat — the featureTitle, the summary, and the per-case title + confidence verdicts. Do not just say it is available in the UI.',
          'Give the user archivePath as the exact local file location now. The archive already exists; do not send a separate download command.',
        ],
      })
    } catch (err) {
      return failureResult(err)
    }
  })

  registerTool('list_evaluation_exports', {
    description: 'List persisted evaluation export tasks. Returned as a TOON table: a `[N]{col,...}:` header line followed by one comma-separated row per task (quoted cells are JSON-escaped strings).',
    inputSchema: { runId: z.string().optional() },
  }, async ({ runId }) => {
    const tasks = listEvaluationExportTasks(deps.store.logsDir, runId ? { runId } : {})
    return asToonResult(tasks.map((task) => evaluationExportToolView(deps.store.logsDir, task)))
  })

  registerTool('get_evaluation_export', {
    description: 'Fetch one evaluation export task.',
    inputSchema: { taskId: z.string() },
  }, async ({ taskId }) => {
    const task = readEvaluationExportTask(deps.store.logsDir, taskId)
    if (!task) return errorResult(`evaluation export task not found: ${taskId}`)
    return asJsonResult(evaluationExportToolView(deps.store.logsDir, task))
  })

  registerTool('download_evaluation_export', {
    description: 'Return a completed evaluation export archive path plus base64 for clients that cannot access the server filesystem.',
    inputSchema: { taskId: z.string() },
  }, async ({ taskId }) => {
    const task = readEvaluationExportTask(deps.store.logsDir, taskId)
    if (!task) return errorResult(`evaluation export task not found: ${taskId}`)
    const zip = task.status === 'completed' ? readEvaluationExportZip(deps.store.logsDir, taskId) : null
    if (!zip) return errorResult('evaluation export is not ready')
    const taskView = evaluationExportToolView(deps.store.logsDir, task)
    return asJsonResult({
      task: taskView,
      archivePath: taskView.archivePath,
      reportInsideArchive: taskView.reportInsideArchive,
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
    return asJsonResult({ deleted: true, taskId })
  })
}
