export type AgentSessionEvent =
  | { kind: 'user-message'; timestamp: string; text: string }
  // `apiError` marks a turn the CLI synthesized after the model's HTTP stream
  // dropped mid-response ("Connection closed mid-response"). It is NOT the
  // agent's own prose — the surrounding text is whatever partial output was
  // recovered — so the UI renders it as a termination, not a conclusion.
  | { kind: 'assistant-message'; timestamp: string; text: string; apiError?: boolean }
  | { kind: 'assistant-thinking'; timestamp: string; text: string }
  | { kind: 'tool-call'; timestamp: string; toolId: string; name: string; input: unknown }
  | { kind: 'tool-result'; timestamp: string; toolId: string; output: string; isError?: boolean }

// Session-level metadata that doesn't map to a timeline event: which model the
// agent ran and (codex only) its reasoning effort. Both agents record this in
// their JSONL but in different lines — codex in a `turn_context` record,
// claude in each assistant message's `message.model`. Claude has no notion of
// reasoning effort, so `effort` stays undefined for it.
export interface AgentSessionMeta {
  model?: string
  effort?: string
}

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

