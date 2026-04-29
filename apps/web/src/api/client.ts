// Typed fetch wrappers around the Fastify server's REST endpoints. Pure
// functions — they accept a `fetch` impl via injection so tests can stub it.
// Production callers use the default (the global `fetch`).

import type {
  Feature,
  FeatureTests,
  RunIndexEntry,
  RunDetail,
  JournalEntry,
} from './types'

export class ApiError extends Error {
  readonly status: number
  readonly body: unknown
  constructor(status: number, body: unknown, message?: string) {
    super(message ?? `HTTP ${status}`)
    this.name = 'ApiError'
    this.status = status
    this.body = body
  }
}

export type FetchLike = typeof fetch

export interface ClientOptions {
  baseUrl?: string
  fetchImpl?: FetchLike
}

const defaultOpts = (opts?: ClientOptions): Required<ClientOptions> => ({
  baseUrl: opts?.baseUrl ?? '',
  fetchImpl: opts?.fetchImpl ?? globalThis.fetch.bind(globalThis),
})

async function request<T>(
  url: string,
  init: RequestInit,
  fetchImpl: FetchLike,
): Promise<T> {
  const res = await fetchImpl(url, init)
  const text = await res.text()
  let body: unknown = null
  if (text.length > 0) {
    try {
      body = JSON.parse(text)
    } catch {
      body = text
    }
  }
  if (!res.ok) {
    throw new ApiError(res.status, body)
  }
  return body as T
}

export function listFeatures(opts?: ClientOptions): Promise<Feature[]> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<Feature[]>(`${baseUrl}/api/features`, { method: 'GET' }, fetchImpl)
}

export function getFeatureTests(name: string, opts?: ClientOptions): Promise<FeatureTests> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<FeatureTests>(
    `${baseUrl}/api/features/${encodeURIComponent(name)}/tests`,
    { method: 'GET' },
    fetchImpl,
  )
}

export function listRuns(
  query: { feature?: string } = {},
  opts?: ClientOptions,
): Promise<RunIndexEntry[]> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  const qs = query.feature ? `?feature=${encodeURIComponent(query.feature)}` : ''
  return request<RunIndexEntry[]>(`${baseUrl}/api/runs${qs}`, { method: 'GET' }, fetchImpl)
}

export function getRunDetail(runId: string, opts?: ClientOptions): Promise<RunDetail> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<RunDetail>(
    `${baseUrl}/api/runs/${encodeURIComponent(runId)}`,
    { method: 'GET' },
    fetchImpl,
  )
}

export function startRun(feature: string, opts?: ClientOptions): Promise<{ runId: string }> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<{ runId: string }>(
    `${baseUrl}/api/runs`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ feature }),
    },
    fetchImpl,
  )
}

export async function stopRun(runId: string, opts?: ClientOptions): Promise<void> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  await request<unknown>(
    `${baseUrl}/api/runs/${encodeURIComponent(runId)}`,
    { method: 'DELETE' },
    fetchImpl,
  )
}

export async function deleteJournalEntry(
  iteration: number,
  opts?: ClientOptions,
): Promise<void> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  await request<unknown>(
    `${baseUrl}/api/journal/${encodeURIComponent(String(iteration))}`,
    { method: 'DELETE' },
    fetchImpl,
  )
}

export function listJournal(
  query: { feature?: string; run?: string } = {},
  opts?: ClientOptions,
): Promise<JournalEntry[]> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  const params = new URLSearchParams()
  if (query.feature) params.set('feature', query.feature)
  if (query.run) params.set('run', query.run)
  const qs = params.toString() ? `?${params.toString()}` : ''
  return request<JournalEntry[]>(`${baseUrl}/api/journal${qs}`, { method: 'GET' }, fetchImpl)
}
