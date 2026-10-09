import { downloadBlob } from '../lib/download'
// Evaluation exports: start, poll, cancel, download.
// Split out of client.ts; see that barrel for the shared surface.

import type {
  EvaluationExportMode,
  EvaluationExportTaskView,
} from '@shared/evaluation-export-types'
import { requestJson, ApiError, defaultOpts, readResponseBody, request, type ClientOptions } from './internal'
import { evaluationTaskFilename } from '@shared/evaluation-archive-naming'

export function startEvaluationExport(
  runId: string,
  mode: EvaluationExportMode,
  opts?: ClientOptions,
): Promise<EvaluationExportTaskView> {
  return requestJson<EvaluationExportTaskView>(`/api/runs/${encodeURIComponent(runId)}/evaluation-export`, 'POST', { mode }, opts)
}

export function getEvaluationExportTask(
  taskId: string,
  opts?: ClientOptions,
): Promise<EvaluationExportTaskView> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<EvaluationExportTaskView>(
    `${baseUrl}/api/evaluation-exports/${encodeURIComponent(taskId)}`,
    { method: 'GET' },
    fetchImpl,
  )
}

export function listEvaluationExportTasks(
  query: { runId?: string } = {},
  opts?: ClientOptions,
): Promise<EvaluationExportTaskView[]> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  const qs = query.runId ? `?runId=${encodeURIComponent(query.runId)}` : ''
  return request<EvaluationExportTaskView[]>(
    `${baseUrl}/api/evaluation-exports${qs}`,
    { method: 'GET' },
    fetchImpl,
  )
}

export async function cancelEvaluationExportTask(
  taskId: string,
  opts?: ClientOptions,
): Promise<void> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  await request<unknown>(
    `${baseUrl}/api/evaluation-exports/${encodeURIComponent(taskId)}`,
    { method: 'DELETE' },
    fetchImpl,
  )
}

export async function downloadEvaluationExportTask(
  task: EvaluationExportTaskView,
  opts: ClientOptions & {
    documentRef?: Document
    urlApi?: Pick<typeof URL, 'createObjectURL' | 'revokeObjectURL'>
  } = {},
): Promise<void> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  const res = await fetchImpl(
    `${baseUrl}/api/evaluation-exports/${encodeURIComponent(task.taskId)}/download`,
    { method: 'GET' },
  )
  if (!res.ok) throw new ApiError(res.status, await readResponseBody(res))
  downloadBlob(await res.blob(), evaluationTaskFilename(task), opts)

}
