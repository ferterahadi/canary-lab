import type { AgentSessionEvent } from './client'

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

const defaultWsBase = (): string => {
  if (typeof location === 'undefined') return 'ws://127.0.0.1:7421'
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${location.host}`
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
  return `${base}/ws/draft/${encodeURIComponent(source.draftId)}/agent-session?stage=${encodeURIComponent(source.stage)}`
}

export function connectAgentSessionStream(opts: ConnectAgentSessionOptions): AgentSessionConnection {
  const WSImpl = opts.WebSocketImpl ?? (globalThis as { WebSocket?: typeof WebSocket }).WebSocket
  if (!WSImpl) throw new Error('WebSocket implementation not available')
  const base = opts.wsBase ?? defaultWsBase()
  const url = urlFor(base, opts.source)
  const maxReconnects = opts.maxReconnects ?? 1

  let closed = false
  let done = false
  let reconnectsLeft = maxReconnects
  let socket: WebSocket | null = null

  const open = (): void => {
    const ws = new WSImpl(url)
    socket = ws
    ws.onmessage = (ev: MessageEvent): void => {
      let msg: AgentSessionSocketMessage
      try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '') as AgentSessionSocketMessage } catch { return }
      if (msg.type === 'session' && msg.agent && typeof msg.sessionId === 'string') {
        opts.onSession?.({ agent: msg.agent, sessionId: msg.sessionId, model: msg.model, effort: msg.effort })
      } else if (msg.type === 'event' && msg.event) {
        opts.onEvent(msg.event)
      } else if (msg.type === 'error') {
        opts.onError?.(msg.error ?? 'unknown error')
      } else if (msg.type === 'done') {
        done = true
        opts.onDone?.()
      }
    }
    ws.onclose = (): void => {
      socket = null
      if (closed || done) return
      if (reconnectsLeft > 0) {
        reconnectsLeft -= 1
        open()
      }
    }
    ws.onerror = (): void => {
      opts.onError?.('socket error')
    }
  }

  open()

  return {
    close(): void {
      closed = true
      if (socket && socket.readyState <= 1) {
        try { socket.close() } catch { /* already gone */ }
      }
      socket = null
    },
  }
}
