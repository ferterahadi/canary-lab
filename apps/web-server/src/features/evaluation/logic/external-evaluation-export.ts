import type { ClientKind } from '../../../../../../shared/run-mode'
import type { RunDetail } from '../../runs/logic/run-store'
import {
  appendEvaluationExportLog,
  createEvaluationExportTask,
  patchEvaluationExportTask,
  writeEvaluationExportZip,
  type EvaluationExportTaskRecord,
} from './evaluation-export-store'
import { buildEvaluationExportArchive } from './evaluation-export-archive'
import type { EvaluationRewrite } from './test-review-export'

// The externally-authored evaluation export's task lifecycle — one home shared
// by the MCP tool pair (start/submit_external_evaluation_export) and the
// flight's evaluation-export hand-off, so a flight-created task and a
// tool-created one are the same record with the same completion path. The
// export stays Canary's render of client-authored WORDING: the archive builder
// runs here, never on the client, and a failed run's status is preserved.

export function newEvaluationTaskId(): string {
  return `eval-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export function safeFilename(input: string): string {
  return input.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'export'
}

export function evaluationArchiveBase(feature: string, runId: string): string {
  return `canary-lab-evaluation-${safeFilename(feature)}-${safeFilename(runId)}`
}

export interface CreateExternalEvaluationTaskArgs {
  logsDir: string
  detail: RunDetail
  /** Stable id of whoever drives the task — an MCP session, or `flight:<id>`. */
  sessionId: string
  clientKind?: ClientKind
  conversationName?: string
  language?: string
  sessionUrl?: string
  now?: () => string
  newTaskId?: () => string
}

/** Create (and persist) an external evaluation-export task for a finished run. */
export function createExternalEvaluationExportTask(args: CreateExternalEvaluationTaskArgs): EvaluationExportTaskRecord {
  const now = (args.now ?? (() => new Date().toISOString()))()
  const task: EvaluationExportTaskRecord = {
    taskId: (args.newTaskId ?? newEvaluationTaskId)(),
    runId: args.detail.runId,
    feature: args.detail.manifest.feature,
    mode: 'localized',
    producer: 'external',
    status: 'running',
    createdAt: now,
    updatedAt: now,
    downloadReady: false,
    archiveBase: evaluationArchiveBase(args.detail.manifest.feature, args.detail.runId),
    sessionId: args.sessionId,
    ...(args.clientKind ? { clientKind: args.clientKind } : {}),
    ...(args.conversationName ? { conversationName: args.conversationName } : {}),
    ...(args.language ? { language: args.language } : {}),
    ...(args.sessionUrl ? { externalSessionUrl: args.sessionUrl } : {}),
  }
  createEvaluationExportTask(args.logsDir, task)
  appendEvaluationExportLog(args.logsDir, task.taskId, '[evaluation] external export task created\n')
  return task
}

export type CompleteExternalEvaluationResult =
  | { ok: true; task: EvaluationExportTaskRecord }
  | { ok: false; error: string }

/** Render an already-normalized rewrite through the canonical HTML export,
 *  store the zip beside the task, and flip it completed. The caller owns
 *  normalization (the MCP tool via its input schema, the flight via
 *  resolveRewriteOutput) — this is the one completion path after it. */
export async function completeExternalEvaluationExport(args: {
  logsDir: string
  detail: RunDetail
  taskId: string
  rewrite: EvaluationRewrite
}): Promise<CompleteExternalEvaluationResult> {
  const built = await buildEvaluationExportArchive(args.detail, {
    logsDir: args.logsDir,
    audienceAdapter: 'deterministic',
    rewrite: args.rewrite,
  })
  writeEvaluationExportZip(args.logsDir, args.taskId, built.zip)
  appendEvaluationExportLog(args.logsDir, args.taskId, '[evaluation] external report submitted\n')
  const next = patchEvaluationExportTask(args.logsDir, args.taskId, {
    archiveBase: built.archiveBase,
    archive: built.contents,
    status: 'completed',
    downloadReady: true,
  })
  // A task deleted between the zip write and the patch (Log Cleanup mid-submit)
  // has nowhere to record completion — recoverable for the caller, not a throw.
  if (!next) return { ok: false, error: `evaluation export task disappeared mid-submit: ${args.taskId}` }
  return { ok: true, task: next }
}
