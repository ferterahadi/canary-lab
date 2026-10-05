// Evaluation exports: start, poll, cancel, download.
// Split out of client.ts; see that barrel for the shared surface.

import type {
  EvaluationExportMode,
  EvaluationExportTaskView,
} from '@shared/evaluation-export-types'
import { ApiError, defaultOpts, readResponseBody, request, type ClientOptions } from './internal'
import { evaluationTaskFilename } from '@shared/evaluation-archive-naming'

export function startEvaluationExport(
  runId: string,
  mode: EvaluationExportMode,
  opts?: ClientOptions,
): Promise<EvaluationExportTaskView> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<EvaluationExportTaskView>(
    `${baseUrl}/api/runs/${encodeURIComponent(runId)}/evaluation-export`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode }),
    },
    fetchImpl,
  )
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
  const documentRef = opts.documentRef ?? document
  const urlApi = opts.urlApi ?? URL
  const res = await fetchImpl(
    `${baseUrl}/api/evaluation-exports/${encodeURIComponent(task.taskId)}/download`,
    { method: 'GET' },
  )
  if (!res.ok) throw new ApiError(res.status, await readResponseBody(res))
  const href = urlApi.createObjectURL(await res.blob())
  const link = documentRef.createElement('a')
  try {
    link.href = href
    link.download = evaluationTaskFilename(task)
    link.style.display = 'none'
    documentRef.body.appendChild(link)
    link.click()
  } finally {
    link.remove()
    urlApi.revokeObjectURL(href)
  }
}
