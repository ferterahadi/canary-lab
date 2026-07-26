// Port-ification workflows: start, review, save, revise, remove.
// Split out of client.ts; see that barrel for the shared surface.

import type { ClientKind, RunProducer } from '@shared/run-mode'
import { ApiError, defaultOpts, request, type ClientOptions } from './internal'
import type { AgentSessionResponse } from './agent-sessions'

export type PortifyStatus =
  | 'planning' | 'editing' | 'verifying' | 'ready-to-save' | 'saved'
  | 'failed' | 'aborted'

export interface PortifyBootInstance {
  ports: Record<string, number>
  ok: boolean
  failedService?: string
  detail?: string
}

export interface PortifyRepoState {
  name: string
  path: string
  worktreePath?: string
  baseSha?: string
}

export interface PortifyIndexEntry {
  workflowId: string
  feature: string
  status: PortifyStatus
  branch?: string
  startedAt: string
  endedAt?: string
}

export type PortifyProducer = RunProducer

export type PortifyClientKind = ClientKind

export interface PortifyExternalSession {
  clientKind: PortifyClientKind
  sessionId: string
  conversationName?: string
  sessionUrl?: string
}

export interface PortifyManifest {
  workflowId: string
  feature: string
  repos: PortifyRepoState[]
  agent: 'claude' | 'codex'
  /** Defaults to 'internal' on legacy manifests. 'external' = agent ran in the
   *  user's own client and edited the worktree in place. */
  producer?: PortifyProducer
  external?: PortifyExternalSession
  branch: string
  status: PortifyStatus
  attempt: number
  maxAttempts: number
  feedbackRounds?: number
  startedAt: string
  endedAt?: string
  diff?: string
  verification?: { ok: boolean; instances: PortifyBootInstance[]; failureDetail?: string; notPortFixable?: boolean }
  error?: string
}

export function startPortify(
  input: { feature: string; agent?: 'claude' | 'codex'; maxAttempts?: number },
  opts?: ClientOptions,
): Promise<{ workflowId: string }> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<{ workflowId: string }>(
    `${baseUrl}/api/portify`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) },
    fetchImpl,
  )
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
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<PortifyManifest>(
    `${baseUrl}/api/portify/${encodeURIComponent(workflowId)}/revise`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ feedback }) },
    fetchImpl,
  )
}

export function removePortify(workflowId: string, opts?: ClientOptions): Promise<{ workflowId: string; removed: true }> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<{ workflowId: string; removed: true }>(
    `${baseUrl}/api/portify/${encodeURIComponent(workflowId)}`,
    { method: 'DELETE' },
    fetchImpl,
  )
}

export async function getPortifyAgentSession(
  workflowId: string,
  opts?: ClientOptions,
): Promise<AgentSessionResponse | null> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  try {
    return await request<AgentSessionResponse>(
      `${baseUrl}/api/portify/${encodeURIComponent(workflowId)}/agent-session`,
      { method: 'GET' },
      fetchImpl,
    )
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null
    throw err
  }
}
