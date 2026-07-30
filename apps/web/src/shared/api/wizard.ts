// Test-authoring drafts: list, inspect, stop, delete.
// Split out of client.ts; see that barrel for the shared surface.
//
// Read/track only. Drafts are AUTHORED by external MCP clients — the internal
// two-stage wizard (plan agent → spec agent) was retired in favour of the flight
// pipeline, so there is nothing here that starts or accepts a local agent's work.

import type { DraftRecord } from './types'
import { defaultOpts, request, type ClientOptions } from './internal'

export function listDrafts(opts?: ClientOptions): Promise<DraftRecord[]> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<DraftRecord[]>(
    `${baseUrl}/api/tests/draft`,
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

export async function deleteDraft(id: string, opts?: ClientOptions): Promise<void> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  await request<unknown>(
    `${baseUrl}/api/tests/draft/${encodeURIComponent(id)}`,
    { method: 'DELETE' },
    fetchImpl,
  )
}
