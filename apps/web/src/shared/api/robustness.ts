// Robustness Lab (D16): the matrix jobs a suite has run and the findings each
// one carries. Read-only here — a job is started by the flight's Robustness
// stage (or the `start_robustness` MCP tool) through the server route, and a
// finding is acted on through `startRun` with its shrunk envelope as the
// `perturbation`. The record's shape lives in `shared/robustness/jobs.ts`,
// imported rather than mirrored, so the pane cannot drift from the store.
import type { RobustnessJobIndexEntry, RobustnessJobManifest } from '@shared/robustness/jobs'
import { defaultOpts, request, type ClientOptions } from './internal'

/** Every suite's jobs, newest first — the one read behind the live verb. */
export function listAllRobustnessJobs(opts?: ClientOptions): Promise<RobustnessJobIndexEntry[]> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<RobustnessJobIndexEntry[]>(`${baseUrl}/api/robustness`, { method: 'GET' }, fetchImpl)
}

export function listRobustnessJobs(feature: string, opts?: ClientOptions): Promise<RobustnessJobIndexEntry[]> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<RobustnessJobIndexEntry[]>(
    `${baseUrl}/api/features/${encodeURIComponent(feature)}/robustness`,
    { method: 'GET' },
    fetchImpl,
  )
}

export function getRobustnessJob(jobId: string, opts?: ClientOptions): Promise<RobustnessJobManifest> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<RobustnessJobManifest>(
    `${baseUrl}/api/robustness/${encodeURIComponent(jobId)}`,
    { method: 'GET' },
    fetchImpl,
  )
}
