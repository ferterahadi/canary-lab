// Test-authoring drafts: create, inspect, accept plan/spec, reject.
// Split out of client.ts; see that barrel for the shared surface.

import type {
  CreateDraftPayload,
  CreateDraftResponse,
  DraftRecord,
  PlanStep,
  DraftPrdDocument,
} from './types'
import { defaultOpts, request, type ClientOptions } from './internal'

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

export function listDrafts(opts?: ClientOptions): Promise<DraftRecord[]> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<DraftRecord[]>(
    `${baseUrl}/api/tests/draft`,
    { method: 'GET' },
    fetchImpl,
  )
}

export function extractPrdDocuments(
  payload: { prdText?: string; files: File[] },
  opts?: ClientOptions,
): Promise<{ prdText: string; documents: DraftPrdDocument[] }> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  const form = new FormData()
  if (payload.prdText) form.append('prdText', payload.prdText)
  for (const file of payload.files) form.append('files', file)
  return request<{ prdText: string; documents: DraftPrdDocument[] }>(
    `${baseUrl}/api/tests/prd-documents`,
    { method: 'POST', body: form },
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

export function getDraftAgentLog(
  id: string,
  stage: 'planning' | 'generating',
  opts?: ClientOptions,
): Promise<{ content: string }> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<{ content: string }>(
    `${baseUrl}/api/tests/draft/${encodeURIComponent(id)}/agent-log?stage=${encodeURIComponent(stage)}`,
    { method: 'GET' },
    fetchImpl,
  )
}

export function cancelDraftGeneration(
  id: string,
  opts?: ClientOptions,
): Promise<{ draftId: string; status: DraftRecord['status'] }> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<{ draftId: string; status: DraftRecord['status'] }>(
    `${baseUrl}/api/tests/draft/${encodeURIComponent(id)}/cancel-generation`,
    { method: 'POST' },
    fetchImpl,
  )
}

export function acceptPlan(
  id: string,
  plan?: PlanStep[],
  intentSummary?: string,
  opts?: ClientOptions,
): Promise<{ draftId: string; status: string }> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  const body: { plan?: PlanStep[]; intentSummary?: string } = {}
  if (plan) body.plan = plan
  if (intentSummary !== undefined) body.intentSummary = intentSummary
  return request<{ draftId: string; status: string }>(
    `${baseUrl}/api/tests/draft/${encodeURIComponent(id)}/accept-plan`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
    fetchImpl,
  )
}

export function acceptSpec(
  id: string,
  featureName?: string,
  opts?: ClientOptions,
): Promise<{ draftId: string; status: string; featureDir: string; devDependenciesAdded?: string[] }> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<{ draftId: string; status: string; featureDir: string; devDependenciesAdded?: string[] }>(
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
