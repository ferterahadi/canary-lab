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
  readEvaluationExportCertificate,
  readEvaluationExportTask,
  readEvaluationExportZip,
  type EvaluationExportTaskRecord,
  type EvaluationExportTaskView,
} from '../../features/evaluation/logic/evaluation-export-store'
import { completeExternalEvaluationExport, createExternalEvaluationExportTask } from '../../features/evaluation/logic/external-evaluation-export'
import { applyEvaluationTextSlotRewrite, buildTestReviewPacket, deterministicEvaluationRewrite, normalizeEvaluationRewrite, type EvaluationRewrite } from '../../features/evaluation/logic/test-review-export'
import { isTerminalRunStatus } from '../../../../../shared/run-state'
import {
  BEHAVIOR_CERTIFICATE_CHECKER_FILENAME,
  BEHAVIOR_CERTIFICATE_FILENAME,
  type BehaviorCertificate,
} from '../../../../../shared/verification-strength/certificate'
import { type ToolGroupContext, asJsonResult, asToonResult, errorResult, evaluationRewriteInput, evaluationTextSlotInput, externalEvaluationReportSchema, failureResult, gettingStartedBusyResult } from '../tool-support'

type EvaluationExportToolView = EvaluationExportTaskView & {
  archivePath?: string
  reportInsideArchive?: 'evaluation.html'
  /** The behavior certificate beside the zip, and its offline checker inside it. */
  certificatePath?: string
  certificateInsideArchive?: typeof BEHAVIOR_CERTIFICATE_FILENAME
  checkerInsideArchive?: typeof BEHAVIOR_CERTIFICATE_CHECKER_FILENAME
  /** The certificate's headline, sized for a tool result; the full file is at
   *  `certificatePath` and comes inline only from download_evaluation_export. */
  certificate?: CertificateDigest
}

interface CertificateDigest {
  format: BehaviorCertificate['format']
  statement: string
  suite: Pick<BehaviorCertificate['suite'], 'source' | 'digest' | 'runStartCheck'>
  counts: BehaviorCertificate['run']['counts']
  claims: { total: number; allPassed: number; someFailed: number; notRun: number; noTests: number }
  pendingSpecEdits: number | 'unknown'
  hints: number
  notProven: string[]
  verifyOffline: string
}

/** What an agent relays about the certificate without paying for the whole
 *  file: the claim in one sentence, the counts, the suite check, what is not
 *  proven, and how a third party re-checks it. */
export function certificateDigest(certificate: BehaviorCertificate, certificatePath: string): CertificateDigest {
  const claims = { total: certificate.claims.length, allPassed: 0, someFailed: 0, notRun: 0, noTests: 0 }
  for (const claim of certificate.claims) {
    if (claim.outcome === 'all-passed') claims.allPassed += 1
    else if (claim.outcome === 'some-failed') claims.someFailed += 1
    else if (claim.outcome === 'not-run') claims.notRun += 1
    else claims.noTests += 1
  }
  return {
    format: certificate.format,
    statement: certificate.statement,
    suite: { source: certificate.suite.source, digest: certificate.suite.digest, runStartCheck: certificate.suite.runStartCheck },
    counts: certificate.run.counts,
    claims,
    pendingSpecEdits: certificate.specEdits ? certificate.specEdits.pending.length : 'unknown',
    hints: certificate.hints.length,
    notProven: certificate.notProven,
    verifyOffline: `unzip the archive, then: node ${BEHAVIOR_CERTIFICATE_CHECKER_FILENAME} ${BEHAVIOR_CERTIFICATE_FILENAME}${'dir' in certificate.suite ? ` --suite ${JSON.stringify(certificate.suite.dir)}` : ''} — re-derives the spec hashes, the suite digest and every listed assertion from files on disk, with no Canary Lab code involved (certificate on this machine: ${certificatePath})`,
  }
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
  const withArchive: EvaluationExportToolView = {
    ...view,
    archivePath: path.resolve(paths.zipPath),
    reportInsideArchive: 'evaluation.html',
  }
  // Exports built before certificates existed have a zip and no certificate;
  // they keep reading as completed history without claiming one.
  const certificate = readEvaluationExportCertificate(logsDir, task.taskId)
  if (!certificate) return withArchive
  const certificatePath = path.resolve(paths.certificatePath)
  return {
    ...withArchive,
    certificatePath,
    certificateInsideArchive: BEHAVIOR_CERTIFICATE_FILENAME,
    checkerInsideArchive: BEHAVIOR_CERTIFICATE_CHECKER_FILENAME,
    certificate: certificateDigest(certificate, certificatePath),
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
        featuresDir: deps.featuresDir,
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
          'Relay certificate.statement and certificate.notProven as written: the certificate proves which tests ran from which suite snapshot and what they asserted, not the absence of weakening. Point at certificate.verifyOffline for a third-party re-check.',
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
    description: 'Fetch one evaluation export task. A completed task carries archivePath plus the behavior certificate digest (certificate.statement, counts, suite check, notProven) and certificatePath to the full file.',
    inputSchema: { taskId: z.string() },
  }, async ({ taskId }) => {
    const task = readEvaluationExportTask(deps.store.logsDir, taskId)
    if (!task) return errorResult(`evaluation export task not found: ${taskId}`)
    return asJsonResult(evaluationExportToolView(deps.store.logsDir, task))
  })

  registerTool('download_evaluation_export', {
    description: 'Return a completed evaluation export archive path plus base64 for clients that cannot access the server filesystem, with the full behavior certificate inline.',
    inputSchema: { taskId: z.string() },
  }, async ({ taskId }) => {
    const task = readEvaluationExportTask(deps.store.logsDir, taskId)
    if (!task) return errorResult(`evaluation export task not found: ${taskId}`)
    const zip = task.status === 'completed' ? readEvaluationExportZip(deps.store.logsDir, taskId) : null
    if (!zip) return errorResult('evaluation export is not ready')
    const taskView = evaluationExportToolView(deps.store.logsDir, task)
    // The full certificate rides inline here and nowhere else: this is the one
    // tool a client without filesystem access calls, and it already carries the
    // whole archive as base64, so the certificate adds little beside it.
    const certificate = readEvaluationExportCertificate(deps.store.logsDir, taskId)
    return asJsonResult({
      task: taskView,
      archivePath: taskView.archivePath,
      reportInsideArchive: taskView.reportInsideArchive,
      ...(certificate ? { certificatePath: taskView.certificatePath, certificate } : {}),
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
