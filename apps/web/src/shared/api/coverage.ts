// Requirement coverage: ledgers, PRD summaries, coverage jobs, feature docs.
// Split out of client.ts; see that barrel for the shared surface.

import type {
  CoverageLedger,
  CoverageJobIndexEntry,
  CoverageJobKind,
  CoverageJobManifest,
  FeatureDocsListing,
  PrdSummary,
} from './types'
import { ApiError, defaultOpts, request, type ClientOptions } from './internal'
import { agentSessionAbsence, type AgentSessionAbsence, type AgentSessionResponse } from './agent-sessions'

export function getFeatureCoverage(feature: string, opts?: ClientOptions): Promise<CoverageLedger> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<CoverageLedger>(
    `${baseUrl}/api/features/${encodeURIComponent(feature)}/coverage`,
    { method: 'GET' },
    fetchImpl,
  )
}

export function listFeatureDocs(feature: string, opts?: ClientOptions): Promise<FeatureDocsListing> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<FeatureDocsListing>(
    `${baseUrl}/api/features/${encodeURIComponent(feature)}/docs`,
    { method: 'GET' },
    fetchImpl,
  )
}

export function writeFeatureDoc(
  feature: string,
  relPath: string,
  content: string,
  opts?: ClientOptions,
): Promise<{ written: boolean; relativePath: string }> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request(
    `${baseUrl}/api/features/${encodeURIComponent(feature)}/docs`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ relPath, content }) },
    fetchImpl,
  )
}

/** Upload a source doc file (.md/.txt/.pdf/.docx); the server extracts text and
 *  stores it as a markdown source doc. */
export function importFeatureDoc(
  feature: string,
  file: { filename: string; contentType?: string; base64: string },
  opts?: ClientOptions,
): Promise<{ written: boolean; relativePath: string }> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request(
    `${baseUrl}/api/features/${encodeURIComponent(feature)}/docs/import`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(file) },
    fetchImpl,
  )
}

export function deleteFeatureDoc(feature: string, relPath: string, opts?: ClientOptions): Promise<{ deleted: boolean }> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request(
    `${baseUrl}/api/features/${encodeURIComponent(feature)}/docs/${encodeURIComponent(relPath)}`,
    { method: 'DELETE' },
    fetchImpl,
  )
}

export interface CoverageStateSummary {
  feature: string
  headline: string | null
  summary: string | null
  coverage: string | null
  coveragePct: number | null
}

export function listCoverageStates(opts?: ClientOptions): Promise<CoverageStateSummary[]> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<CoverageStateSummary[]>(`${baseUrl}/api/coverage/states`, { method: 'GET' }, fetchImpl)
}

export function regeneratePrdSummary(
  feature: string,
  adapter?: 'auto' | 'claude' | 'codex' | 'deterministic',
  opts?: ClientOptions,
): Promise<{ feature: string; summary: PrdSummary; written: string[] }> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request(
    `${baseUrl}/api/features/${encodeURIComponent(feature)}/prd-summary/regenerate`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(adapter ? { adapter } : {}) },
    fetchImpl,
  )
}

// ─── Requirement Coverage — async jobs (R4). Summary + Coverage are one exercise:
// a `summary` job auto-chains a `coverage` job server-side (R14), so there is no
// review/accept step. ─────────────────────────────────────────────────────────

export function startCoverageJob(
  feature: string,
  kind: CoverageJobKind,
  opts?: ClientOptions & { adapter?: 'auto' | 'claude' | 'codex' | 'deterministic'; gettingStartedSource?: 'internal' | 'external' },
): Promise<CoverageJobManifest> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  const body: Record<string, unknown> = { kind }
  if (opts?.adapter) body.adapter = opts.adapter
  if (opts?.gettingStartedSource) body.gettingStartedSource = opts.gettingStartedSource
  return request<CoverageJobManifest>(
    `${baseUrl}/api/features/${encodeURIComponent(feature)}/coverage/jobs`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    fetchImpl,
  )
}

export function listCoverageJobs(feature: string, opts?: ClientOptions): Promise<CoverageJobIndexEntry[]> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<CoverageJobIndexEntry[]>(
    `${baseUrl}/api/features/${encodeURIComponent(feature)}/coverage/jobs`,
    { method: 'GET' },
    fetchImpl,
  )
}

export function listAllCoverageJobs(opts?: ClientOptions): Promise<CoverageJobIndexEntry[]> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<CoverageJobIndexEntry[]>(`${baseUrl}/api/coverage/jobs`, { method: 'GET' }, fetchImpl)
}

export function getCoverageJob(jobId: string, opts?: ClientOptions): Promise<CoverageJobManifest> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<CoverageJobManifest>(
    `${baseUrl}/api/coverage/jobs/${encodeURIComponent(jobId)}`,
    { method: 'GET' },
    fetchImpl,
  )
}

/** 404 (unknown job) → an `AgentSessionAbsence`; the route also answers 200
 *  `null` while the job's session log isn't locatable on disk yet. */
export async function getCoverageAgentSession(
  jobId: string,
  opts?: ClientOptions,
): Promise<AgentSessionResponse | AgentSessionAbsence | null> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  try {
    return await request<AgentSessionResponse | null>(
      `${baseUrl}/api/coverage/jobs/${encodeURIComponent(jobId)}/agent-session`,
      { method: 'GET' },
      fetchImpl,
    )
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return agentSessionAbsence(err)
    throw err
  }
}

/** 404 → an `AgentSessionAbsence` with the server's reason (a raw export has
 *  no agent session, ever — it reports `no-session-ref`). */
export async function getEvaluationAgentSession(
  taskId: string,
  opts?: ClientOptions,
): Promise<AgentSessionResponse | AgentSessionAbsence> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  try {
    return await request<AgentSessionResponse>(
      `${baseUrl}/api/evaluation-exports/${encodeURIComponent(taskId)}/agent-session`,
      { method: 'GET' },
      fetchImpl,
    )
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return agentSessionAbsence(err)
    throw err
  }
}

export function clearPrdSummary(feature: string, opts?: ClientOptions): Promise<{ feature: string; removed: string[]; untagged: string[] }> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request(
    `${baseUrl}/api/features/${encodeURIComponent(feature)}/prd-summary`,
    { method: 'DELETE' },
    fetchImpl,
  )
}

// ─── Benchmark ─────────────────────────────────────────────────────────────
