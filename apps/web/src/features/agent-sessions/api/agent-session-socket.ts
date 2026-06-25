import { connectReconnectingSocket, defaultWsBase } from '../../../shared/api/reconnecting-socket'
import type { AgentSessionEvent } from '../../../shared/api/client'

// WebSocket wrapper for live structured agent-session events. Source is
// either a run id or a (draftId, stage) pair — the server routes are
// /ws/runs/:runId/agent-session and /ws/draft/:draftId/agent-session?stage=
// respectively, and emit messages of the form { type: 'session', ... } |
// { type: 'event', event } | { type: 'error', error }.

export type AgentSessionSocketSource =
  | { kind: 'run'; runId: string }
  | { kind: 'draft'; draftId: string; stage: 'planning' | 'generating' }
  | { kind: 'benchmark'; benchmarkId: string }
  | { kind: 'portify'; workflowId: string }
  | { kind: 'coverage'; jobId: string }
  | { kind: 'evaluation'; taskId: string }

export interface AgentSessionSocketMessage {
  type: 'session' | 'event' | 'error' | 'done'
  agent?: 'claude' | 'codex'
  sessionId?: string
  model?: string
  effort?: string
  event?: AgentSessionEvent
  error?: string
}

export interface ConnectAgentSessionOptions {
  source: AgentSessionSocketSource
  onSession?: (session: { agent: 'claude' | 'codex'; sessionId: string; model?: string; effort?: string }) => void
  onEvent: (event: AgentSessionEvent) => void
  onError?: (err: string) => void
  onDone?: () => void
  wsBase?: string
  WebSocketImpl?: typeof WebSocket
  maxReconnects?: number
}

export interface AgentSessionConnection {
  close(): void
}

function urlFor(base: string, source: AgentSessionSocketSource): string {
  if (source.kind === 'run') {
    return `${base}/ws/runs/${encodeURIComponent(source.runId)}/agent-session`
  }
  if (source.kind === 'benchmark') {
    return `${base}/ws/benchmarks/${encodeURIComponent(source.benchmarkId)}/agent-session`
  }
  if (source.kind === 'portify') {
    return `${base}/ws/portify/${encodeURIComponent(source.workflowId)}/agent-session`
  }
  if (source.kind === 'coverage') {
    return `${base}/ws/coverage/jobs/${encodeURIComponent(source.jobId)}/agent-session`
  }
  if (source.kind === 'evaluation') {
    return `${base}/ws/evaluation-exports/${encodeURIComponent(source.taskId)}/agent-session`
  }
  return `${base}/ws/draft/${encodeURIComponent(source.draftId)}/agent-session?stage=${encodeURIComponent(source.stage)}`
}

export function connectAgentSessionStream(opts: ConnectAgentSessionOptions): AgentSessionConnection {
  const base = opts.wsBase ?? defaultWsBase()
  const conn = connectReconnectingSocket({
    url: urlFor(base, opts.source),
    WebSocketImpl: opts.WebSocketImpl,
    maxReconnects: opts.maxReconnects,
    onError: opts.onError,
    onMessage: (data) => {
      let msg: AgentSessionSocketMessage
      try { msg = JSON.parse(data) as AgentSessionSocketMessage } catch { return }
      if (msg.type === 'session' && msg.agent && typeof msg.sessionId === 'string') {
        opts.onSession?.({ agent: msg.agent, sessionId: msg.sessionId, model: msg.model, effort: msg.effort })
      } else if (msg.type === 'event' && msg.event) {
        opts.onEvent(msg.event)
      } else if (msg.type === 'error') {
        opts.onError?.(msg.error ?? 'unknown error')
      } else if (msg.type === 'done') {
        conn.markDone()
        opts.onDone?.()
      }
    },
  })
  return { close: () => conn.close() }
}
