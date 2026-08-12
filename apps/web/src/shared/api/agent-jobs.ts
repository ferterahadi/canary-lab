// Durable records of the agents Canary spawned: which ran, how each ended, and
// which are still live enough to stop.
//
// A live row is what makes a per-agent stop offerable at all — before these
// records existed, the only way to stop an agent from the UI was to pause the
// whole flight. A terminal row is worth showing too: `orphaned` means the server
// exited while the agent was running, and its transcript is still readable.

import { defaultOpts, request, type ClientOptions } from './internal'

export type AgentJobStatus = 'running' | 'done' | 'failed' | 'stopped' | 'orphaned'

export interface AgentJobRow {
  jobId: string
  flightId?: string
  feature?: string
  stage?: string
  status: AgentJobStatus
  startedAt: string
  endedAt?: string
}

export async function fetchAgentJobs(flightId?: string, opts?: ClientOptions): Promise<AgentJobRow[]> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  const query = flightId ? `?flight=${encodeURIComponent(flightId)}` : ''
  const body = await request<{ jobs?: AgentJobRow[] }>(`${baseUrl}/api/agent-jobs${query}`, { method: 'GET' }, fetchImpl)
  // An older server, or a body that lost the key: callers render a list and must
  // not have to guard for undefined.
  return body.jobs ?? []
}

export interface StopAgentJobResult {
  stopped: boolean
  /** Present when nothing was stopped — the status that made it a no-op. */
  status?: AgentJobStatus
}

/** Stop one agent. Note what this does to a flight: it is WAITING on that stage,
 *  so the stage attempt fails and the flight parks `stage-failed` (resumable).
 *  The run and the export are left alone — that is the difference from a pause. */
export function stopAgentJob(jobId: string, opts?: ClientOptions): Promise<StopAgentJobResult> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<StopAgentJobResult>(
    `${baseUrl}/api/agent-jobs/${encodeURIComponent(jobId)}/stop`,
    { method: 'POST' },
    fetchImpl,
  )
}
