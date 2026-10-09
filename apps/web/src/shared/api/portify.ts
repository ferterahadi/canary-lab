import type { PortifyManifest } from '@shared/portify-index'
// Port-ification workflows: start, review, save, revise, remove.
// Split out of client.ts; see that barrel for the shared surface.

import { requestJson, defaultOpts, request, type ClientOptions } from './internal'
import { requestAgentSession, type AgentSessionAbsence, type AgentSessionResponse } from './agent-sessions'

export function startPortify(
  input: { feature: string; agent?: 'claude' | 'codex'; maxAttempts?: number },
  opts?: ClientOptions,
): Promise<{ workflowId: string }> {
  return requestJson<{ workflowId: string }>(`/api/portify`, 'POST', input, opts)
}

export function getPortify(workflowId: string, opts?: ClientOptions): Promise<PortifyManifest> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<PortifyManifest>(
    `${baseUrl}/api/portify/${encodeURIComponent(workflowId)}`,
    { method: 'GET' },
    fetchImpl,
  )
}

export function savePortify(workflowId: string, opts?: ClientOptions): Promise<PortifyManifest> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<PortifyManifest>(
    `${baseUrl}/api/portify/${encodeURIComponent(workflowId)}/save`,
    { method: 'POST' },
    fetchImpl,
  )
}

export function cancelPortify(workflowId: string, opts?: ClientOptions): Promise<PortifyManifest> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<PortifyManifest>(
    `${baseUrl}/api/portify/${encodeURIComponent(workflowId)}/cancel`,
    { method: 'POST' },
    fetchImpl,
  )
}

export function revisePortify(
  workflowId: string,
  feedback: string,
  opts?: ClientOptions,
): Promise<PortifyManifest> {
  return requestJson<PortifyManifest>(`/api/portify/${encodeURIComponent(workflowId)}/revise`, 'POST', { feedback }, opts)
}

export function removePortify(workflowId: string, opts?: ClientOptions): Promise<{ workflowId: string; removed: true }> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<{ workflowId: string; removed: true }>(
    `${baseUrl}/api/portify/${encodeURIComponent(workflowId)}`,
    { method: 'DELETE' },
    fetchImpl,
  )
}

/** 404 → an `AgentSessionAbsence` (`no-session`: the workflow never recorded
 *  an agent session). */
export async function getPortifyAgentSession(
  workflowId: string,
  opts?: ClientOptions,
): Promise<AgentSessionResponse | AgentSessionAbsence> {
  return requestAgentSession(
    `/api/portify/${encodeURIComponent(workflowId)}/agent-session`,
    opts,
  )
}
