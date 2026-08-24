// Parsed agent session transcripts (claude/codex JSONL, normalized).
// Split out of client.ts; see that barrel for the shared surface.

import { ApiError, defaultOpts, request, type ClientOptions } from './internal'

// Structured heal-agent session view (claude/codex JSONL parsed + normalized
// into a uniform event stream). 404 on the API maps to an `AgentSessionAbsence`
// carrying the server's reason so the UI can tell "nothing was ever recorded"
// from "the log just hasn't landed yet" without try/catch noise.
export type AgentSessionEvent =
  | { kind: 'user-message'; timestamp: string; text: string }
  // `apiError` marks a turn the CLI synthesized when the model's stream dropped
  // mid-response — the text is recovered partial output, not a conclusion.
  | { kind: 'assistant-message'; timestamp: string; text: string; apiError?: boolean }
  | { kind: 'assistant-thinking'; timestamp: string; text: string }
  | { kind: 'tool-call'; timestamp: string; toolId: string; name: string; input: unknown }
  | { kind: 'tool-result'; timestamp: string; toolId: string; output: string; isError?: boolean }

/** A subagent thread minus its events — the identity carried on live frames. */
export interface SubagentIdentity {
  agentId: string
  /** The parent `tool-call` event's `toolId` this thread hangs under. */
  parentToolId: string
  agentType: string
  description: string
  spawnDepth: number
  logPath: string
}

export type SubagentThread = SubagentIdentity & { events: AgentSessionEvent[] }

export interface AgentSessionResponse {
  agent: 'claude' | 'codex'
  sessionId: string
  // Model the agent ran (both agents) and reasoning effort (codex only).
  model?: string
  effort?: string
  events: AgentSessionEvent[]
  // Threads spawned via the `Agent`/`Task` tool. Claude-only; absent on older
  // servers and always empty for codex, so callers default it to [].
  subagents?: SubagentThread[]
}

/** A 404 from an agent-session endpoint, keeping the server's absence reason.
 *  `no-session` / `no-session-ref`-style reasons mean nothing was ever recorded
 *  for the surface, while `session-log-missing` means a ref exists and the
 *  CLI's file hasn't landed on disk yet. The viewer keys its retry policy on
 *  that difference, so the absence must survive the client mapping instead of
 *  collapsing to `null` (which held historical panes on "Loading session…" for
 *  the full retry back-off even when the server had already said "never ran"). */
export interface AgentSessionAbsence {
  absent: true
  reason: string | null
}

export function isAgentSessionAbsence(
  value: AgentSessionResponse | AgentSessionAbsence | null,
): value is AgentSessionAbsence {
  // `absent` only exists on the absence side of the union, so its presence is
  // the whole discriminant.
  return value !== null && 'absent' in value
}

/** Map a 404 `ApiError` to the absence it reports (`reason` when the body
 *  carries one; the coverage job-not-found body has none). */
export function agentSessionAbsence(err: ApiError): AgentSessionAbsence {
  const body = err.body
  const reason =
    body && typeof body === 'object' && typeof (body as { reason?: unknown }).reason === 'string'
      ? (body as { reason: string }).reason
      : null
  return { absent: true, reason }
}

export async function getAgentSession(
  runId: string,
  opts?: ClientOptions,
): Promise<AgentSessionResponse | AgentSessionAbsence> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  try {
    return await request<AgentSessionResponse>(
      `${baseUrl}/api/runs/${encodeURIComponent(runId)}/agent-session`,
      { method: 'GET' },
      fetchImpl,
    )
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return agentSessionAbsence(err)
    throw err
  }
}

