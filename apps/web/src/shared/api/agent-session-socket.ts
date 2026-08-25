import { connectReconnectingSocket, defaultWsBase } from '@/shared/api/reconnecting-socket'
import type { AgentSessionEvent, SubagentIdentity } from '@/shared/api/client'

// WebSocket wrapper for live structured agent-session events. Each source kind
// names one per-subsystem server stream (/ws/runs/:runId/agent-session and
// friends), which emit messages of the form { type: 'session', ... } |
// { type: 'event', event } | { type: 'error', error }.
//
// This union must stay in step with `AgentSessionSource` in
// `@/shared/ui/AgentSessionView` — that is the type hosts actually construct,
// and this is what it is translated into. They had drifted: this one still
// carried a `draft` kind after the Add Test wizard was retired and
// `/api/tests/draft/:id/agent-session` was deleted server-side, so `urlFor`
// silently routed a draft source to the flight-plan endpoint.

export type AgentSessionSocketSource =
  | { kind: 'run'; runId: string }
  | { kind: 'benchmark'; benchmarkId: string }
  | { kind: 'portify'; workflowId: string }
  | { kind: 'coverage'; jobId: string }
  | { kind: 'evaluation'; taskId: string }
  | { kind: 'flight'; flightId: string; stage: string }
  | { kind: 'flight-plan'; taskId: string }

export interface AgentSessionSocketMessage {
  type: 'session' | 'event' | 'subagent' | 'error' | 'done'
  agent?: 'claude' | 'codex'
  sessionId?: string
  model?: string
  effort?: string
  event?: AgentSessionEvent
  /** `subagent` frames only: which thread the event belongs to, and its
   *  position within that thread (the dedupe key — see `SubagentUpdate`). */
  thread?: SubagentIdentity
  index?: number
  error?: string
}

export interface ConnectAgentSessionOptions {
  source: AgentSessionSocketSource
  onSession?: (session: { agent: 'claude' | 'codex'; sessionId: string; model?: string; effort?: string }) => void
  onEvent: (event: AgentSessionEvent) => void
  onSubagentEvent?: (update: { thread: SubagentIdentity; event: AgentSessionEvent; index: number }) => void
  onError?: (err: string) => void
  onDone?: () => void
  wsBase?: string
  WebSocketImpl?: typeof WebSocket
  maxReconnects?: number
}

export interface AgentSessionConnection {
  close(): void
}

// A switch with every kind returning, rather than an if-chain ending in a bare
// fallback. The declared `: string` return type is what enforces it: add a kind
// without a case and the function can fall through to `undefined`, which is a
// compile error here. The old shape had the last kind AS the fallback, so a
// `draft` source that no longer had an endpoint was routed to the flight-plan
// stream instead of failing. No unreachable default arm, so the file stays
// fully covered.
function urlFor(base: string, source: AgentSessionSocketSource): string {
  switch (source.kind) {
    case 'run':
      return `${base}/ws/runs/${encodeURIComponent(source.runId)}/agent-session`
    case 'benchmark':
      return `${base}/ws/benchmarks/${encodeURIComponent(source.benchmarkId)}/agent-session`
    case 'portify':
      return `${base}/ws/portify/${encodeURIComponent(source.workflowId)}/agent-session`
    case 'coverage':
      return `${base}/ws/coverage/jobs/${encodeURIComponent(source.jobId)}/agent-session`
    case 'evaluation':
      return `${base}/ws/evaluation-exports/${encodeURIComponent(source.taskId)}/agent-session`
    case 'flight':
      return `${base}/ws/flights/${encodeURIComponent(source.flightId)}/agent-session?stage=${encodeURIComponent(source.stage)}`
    case 'flight-plan':
      return `${base}/ws/flight-plans/${encodeURIComponent(source.taskId)}/agent-session`
  }
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
      } else if (msg.type === 'subagent' && msg.event && msg.thread && typeof msg.index === 'number') {
        opts.onSubagentEvent?.({ thread: msg.thread, event: msg.event, index: msg.index })
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
