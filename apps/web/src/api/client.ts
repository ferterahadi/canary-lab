// Typed fetch wrappers around the Fastify server's REST endpoints. Pure
// functions — they accept a `fetch` impl via injection so tests can stub it.
// Production callers use the default (the global `fetch`).

import type {
  Feature,
  FeatureTests,
  RunIndexEntry,
  RunDetail,
  JournalEntry,
  SkillSummary,
  SkillRecommendation,
  CreateDraftPayload,
  CreateDraftResponse,
  DraftRecord,
  PlanStep,
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

export function startRun(
  feature: string,
  opts?: ClientOptions & { env?: string },
): Promise<{ runId: string }> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  const body = opts?.env ? { feature, env: opts.env } : { feature }
  return request<{ runId: string }>(
    `${baseUrl}/api/runs`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
    fetchImpl,
  )
}

// Mid-Run Heal: ask the server to interrupt a running test and start the heal
// agent immediately. Resolves with `{ status, failureCount }` on a 202;
// throws ApiError on 409 (the body's `reason` describes which precondition
// failed) or 404 (run not active).
export interface PauseHealSuccess {
  status: 'healing'
  failureCount: number
}

export function pauseHealRun(runId: string, opts?: ClientOptions): Promise<PauseHealSuccess> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<PauseHealSuccess>(
    `${baseUrl}/api/runs/${encodeURIComponent(runId)}/pause-heal`,
    { method: 'POST' },
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

export function listSkills(opts?: ClientOptions): Promise<SkillSummary[]> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<SkillSummary[]>(`${baseUrl}/api/skills`, { method: 'GET' }, fetchImpl)
}

export function recommendSkills(
  body: { prdText: string; topN?: number },
  opts?: ClientOptions,
): Promise<SkillRecommendation[]> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<SkillRecommendation[]>(
    `${baseUrl}/api/skills/recommend`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
    fetchImpl,
  )
}

export function createDraft(
  payload: CreateDraftPayload,
  opts?: ClientOptions,
): Promise<CreateDraftResponse> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<CreateDraftResponse>(
    `${baseUrl}/api/tests/draft`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    },
    fetchImpl,
  )
}

export interface DraftFile {
  path: string
  content: string
  mime: string
}

// Fetch a single generated file inside a draft for the wizard's Spec Review
// step. The server enforces path-traversal hardening; this client just
// percent-encodes each segment so slashes remain in the URL.
export function getDraftFile(
  id: string,
  filePath: string,
  opts?: ClientOptions,
): Promise<DraftFile> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  const safe = filePath.split('/').map(encodeURIComponent).join('/')
  return request<DraftFile>(
    `${baseUrl}/api/tests/draft/${encodeURIComponent(id)}/files/${safe}`,
    { method: 'GET' },
    fetchImpl,
  )
}

export function getDraft(id: string, opts?: ClientOptions): Promise<DraftRecord> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<DraftRecord>(
    `${baseUrl}/api/tests/draft/${encodeURIComponent(id)}`,
    { method: 'GET' },
    fetchImpl,
  )
}

export function acceptPlan(
  id: string,
  plan?: PlanStep[],
  opts?: ClientOptions,
): Promise<{ draftId: string; status: string }> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<{ draftId: string; status: string }>(
    `${baseUrl}/api/tests/draft/${encodeURIComponent(id)}/accept-plan`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(plan ? { plan } : {}),
    },
    fetchImpl,
  )
}

export function acceptSpec(
  id: string,
  featureName?: string,
  opts?: ClientOptions,
): Promise<{ draftId: string; status: string; featureDir: string }> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<{ draftId: string; status: string; featureDir: string }>(
    `${baseUrl}/api/tests/draft/${encodeURIComponent(id)}/accept-spec`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(featureName ? { featureName } : {}),
    },
    fetchImpl,
  )
}

export async function rejectDraft(id: string, opts?: ClientOptions): Promise<void> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  await request<unknown>(
    `${baseUrl}/api/tests/draft/${encodeURIComponent(id)}/reject`,
    { method: 'POST' },
    fetchImpl,
  )
}

export async function deleteDraft(id: string, opts?: ClientOptions): Promise<void> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  await request<unknown>(
    `${baseUrl}/api/tests/draft/${encodeURIComponent(id)}`,
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
