// Parsed agent session transcripts (claude/codex JSONL, normalized).
// Split out of client.ts; see that barrel for the shared surface.

import { ApiError, defaultOpts, request, type ClientOptions } from './internal'

// Structured heal-agent session view (claude/codex JSONL parsed + normalized
// into a uniform event stream). 404 on the API maps to `null` here so the UI
// can fall back to the raw transcript replay without try/catch noise.
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

export async function getAgentSession(
  runId: string,
  opts?: ClientOptions,
): Promise<AgentSessionResponse | null> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  try {
    return await request<AgentSessionResponse>(
      `${baseUrl}/api/runs/${encodeURIComponent(runId)}/agent-session`,
      { method: 'GET' },
      fetchImpl,
    )
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null
    throw err
  }
}

export async function getDraftAgentSession(
  draftId: string,
  stage: 'planning' | 'generating',
  opts?: ClientOptions,
): Promise<AgentSessionResponse | null> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  try {
    return await request<AgentSessionResponse>(
      `${baseUrl}/api/tests/draft/${encodeURIComponent(draftId)}/agent-session?stage=${encodeURIComponent(stage)}`,
      { method: 'GET' },
      fetchImpl,
    )
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null
    throw err
  }
}
