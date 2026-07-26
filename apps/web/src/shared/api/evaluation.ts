// Evaluation exports: start, poll, cancel, download.
// Split out of client.ts; see that barrel for the shared surface.

import type { EvaluationExportMode, EvaluationExportTask } from './types'
import { ApiError, defaultOpts, request, type ClientOptions } from './internal'

export function startEvaluationExport(
  runId: string,
  mode: EvaluationExportMode,
  opts?: ClientOptions,
): Promise<EvaluationExportTask> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<EvaluationExportTask>(
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
): Promise<EvaluationExportTask> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<EvaluationExportTask>(
    `${baseUrl}/api/evaluation-exports/${encodeURIComponent(taskId)}`,
    { method: 'GET' },
    fetchImpl,
  )
}

export function listEvaluationExportTasks(
  query: { runId?: string } = {},
  opts?: ClientOptions,
): Promise<EvaluationExportTask[]> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  const qs = query.runId ? `?runId=${encodeURIComponent(query.runId)}` : ''
  return request<EvaluationExportTask[]>(
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
  task: EvaluationExportTask,
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
    link.download = evaluationExportFilename(task.feature, task.runId)
    link.style.display = 'none'
    documentRef.body.appendChild(link)
    link.click()
  } finally {
    link.remove()
    urlApi.revokeObjectURL(href)
  }
}

function evaluationExportFilename(feature: string, runId: string): string {
  return `canary-lab-evaluation-${safeFilename(feature)}-${safeFilename(runId)}.zip`
}

function safeFilename(input: string): string {
  return input.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'run'
}

async function readResponseBody(res: Response): Promise<unknown> {
  const text = await res.text()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}
