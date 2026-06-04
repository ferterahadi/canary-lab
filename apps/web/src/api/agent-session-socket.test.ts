import { describe, expect, it, vi } from 'vitest'
import { connectAgentSessionStream } from './agent-session-socket'
import type { AgentSessionEvent } from './client'

// Tiny fake WebSocket that records the url it was constructed with and
// exposes hooks for tests to drive `onmessage` / `onclose` / `onerror`.
class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  url: string
  readyState = 0 // CONNECTING
  onmessage?: (ev: { data: string }) => void
  onclose?: () => void
  onerror?: () => void
  closed = false

  constructor(url: string) {
    this.url = url
    FakeWebSocket.instances.push(this)
  }

  send(): void { /* not used */ }
  close(): void {
    this.closed = true
    this.readyState = 3 // CLOSED
  }
}

function reset(): void {
  FakeWebSocket.instances = []
}

const sampleEvent: AgentSessionEvent = {
  kind: 'assistant-message',
  timestamp: '2025-01-01T00:00:00Z',
  text: 'hello',
}

describe('connectAgentSessionStream', () => {
  it('opens /ws/runs/:runId/agent-session for run sources', () => {
    reset()
    connectAgentSessionStream({
      source: { kind: 'run', runId: 'r/1' },
      onEvent: () => {},
      wsBase: 'ws://h',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    })
    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(FakeWebSocket.instances[0].url).toBe('ws://h/ws/runs/r%2F1/agent-session')
  })

  it('opens /ws/benchmarks/:id/agent-session for benchmark sources', () => {
    reset()
    connectAgentSessionStream({
      source: { kind: 'benchmark', benchmarkId: 'bench/1' },
      onEvent: () => {},
      wsBase: 'ws://h',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    })
    expect(FakeWebSocket.instances[0].url).toBe('ws://h/ws/benchmarks/bench%2F1/agent-session')
  })

  it('opens /ws/draft/:id/agent-session?stage= for draft sources', () => {
    reset()
    connectAgentSessionStream({
      source: { kind: 'draft', draftId: 'd-1', stage: 'generating' },
      onEvent: () => {},
      wsBase: 'ws://h',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    })
    expect(FakeWebSocket.instances[0].url).toBe('ws://h/ws/draft/d-1/agent-session?stage=generating')
  })

  it('forwards event messages to onEvent', () => {
    reset()
    const onEvent = vi.fn()
    connectAgentSessionStream({
      source: { kind: 'run', runId: 'r' },
      onEvent,
      wsBase: 'ws://h',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    })
    const ws = FakeWebSocket.instances[0]
    ws.onmessage?.({ data: JSON.stringify({ type: 'event', event: sampleEvent }) })
    expect(onEvent).toHaveBeenCalledWith(sampleEvent)
  })

  it('forwards valid session metadata to onSession', () => {
    reset()
    const onSession = vi.fn()
    connectAgentSessionStream({
      source: { kind: 'run', runId: 'r' },
      onEvent: () => {},
      onSession,
      wsBase: 'ws://h',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    })
    FakeWebSocket.instances[0].onmessage?.({
      data: JSON.stringify({ type: 'session', agent: 'codex', sessionId: 'sess-1' }),
    })
    FakeWebSocket.instances[0].onmessage?.({
      data: JSON.stringify({ type: 'session', agent: 'codex' }),
    })

    expect(onSession).toHaveBeenCalledOnce()
    expect(onSession).toHaveBeenCalledWith({ agent: 'codex', sessionId: 'sess-1' })
  })

  it('forwards error messages to onError', () => {
    reset()
    const onError = vi.fn()
    connectAgentSessionStream({
      source: { kind: 'run', runId: 'r' },
      onEvent: () => {},
      onError,
      wsBase: 'ws://h',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    })
    const ws = FakeWebSocket.instances[0]
    ws.onmessage?.({ data: JSON.stringify({ type: 'error', error: 'bad' }) })
    expect(onError).toHaveBeenCalledWith('bad')
  })

  it('uses fallback error string when message lacks error field', () => {
    reset()
    const onError = vi.fn()
    connectAgentSessionStream({
      source: { kind: 'run', runId: 'r' },
      onEvent: () => {},
      onError,
      wsBase: 'ws://h',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    })
    FakeWebSocket.instances[0].onmessage?.({ data: JSON.stringify({ type: 'error' }) })
    expect(onError).toHaveBeenCalledWith('unknown error')
  })

  it('calls onDone exactly once and stops reconnecting after done', () => {
    reset()
    const onDone = vi.fn()
    connectAgentSessionStream({
      source: { kind: 'run', runId: 'r' },
      onEvent: () => {},
      onDone,
      wsBase: 'ws://h',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    })
    const ws = FakeWebSocket.instances[0]
    ws.onmessage?.({ data: JSON.stringify({ type: 'done' }) })
    ws.onclose?.()
    expect(onDone).toHaveBeenCalledTimes(1)
    expect(FakeWebSocket.instances).toHaveLength(1)
  })

  it('reconnects once on unexpected close', () => {
    reset()
    connectAgentSessionStream({
      source: { kind: 'run', runId: 'r' },
      onEvent: () => {},
      wsBase: 'ws://h',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    })
    expect(FakeWebSocket.instances).toHaveLength(1)
    FakeWebSocket.instances[0].onclose?.()
    expect(FakeWebSocket.instances).toHaveLength(2)
    // No further reconnect after the second close.
    FakeWebSocket.instances[1].onclose?.()
    expect(FakeWebSocket.instances).toHaveLength(2)
  })

  it('respects maxReconnects=0', () => {
    reset()
    connectAgentSessionStream({
      source: { kind: 'run', runId: 'r' },
      onEvent: () => {},
      wsBase: 'ws://h',
      maxReconnects: 0,
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    })
    FakeWebSocket.instances[0].onclose?.()
    expect(FakeWebSocket.instances).toHaveLength(1)
  })

  it('forwards socket-level errors via onError', () => {
    reset()
    const onError = vi.fn()
    connectAgentSessionStream({
      source: { kind: 'run', runId: 'r' },
      onEvent: () => {},
      onError,
      wsBase: 'ws://h',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    })
    FakeWebSocket.instances[0].onerror?.()
    expect(onError).toHaveBeenCalledWith('socket error')
  })

  it('close() does not reconnect', () => {
    reset()
    const conn = connectAgentSessionStream({
      source: { kind: 'run', runId: 'r' },
      onEvent: () => {},
      wsBase: 'ws://h',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    })
    const ws = FakeWebSocket.instances[0]
    ws.readyState = 1 // OPEN
    conn.close()
    expect(ws.closed).toBe(true)
    ws.onclose?.()
    expect(FakeWebSocket.instances).toHaveLength(1)
  })

  it('ignores unparseable messages', () => {
    reset()
    const onEvent = vi.fn()
    const onError = vi.fn()
    connectAgentSessionStream({
      source: { kind: 'run', runId: 'r' },
      onEvent,
      onError,
      wsBase: 'ws://h',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    })
    FakeWebSocket.instances[0].onmessage?.({ data: 'not json' })
    expect(onEvent).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
  })

  it('ignores event messages without an event payload', () => {
    reset()
    const onEvent = vi.fn()
    connectAgentSessionStream({
      source: { kind: 'run', runId: 'r' },
      onEvent,
      wsBase: 'ws://h',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    })
    FakeWebSocket.instances[0].onmessage?.({ data: JSON.stringify({ type: 'event' }) })
    expect(onEvent).not.toHaveBeenCalled()
  })

  it('derives ws:// from http: location when wsBase is omitted', () => {
    reset()
    const original = (globalThis as { location?: { protocol: string; host: string } }).location
    ;(globalThis as { location?: { protocol: string; host: string } }).location = { protocol: 'http:', host: 'h:1234' }
    try {
      connectAgentSessionStream({
        source: { kind: 'run', runId: 'r' },
        onEvent: () => {},
        WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      })
      expect(FakeWebSocket.instances[0].url).toBe('ws://h:1234/ws/runs/r/agent-session')
    } finally {
      ;(globalThis as { location?: unknown }).location = original
    }
  })

  it('derives wss:// from https: location when wsBase is omitted', () => {
    reset()
    const original = (globalThis as { location?: { protocol: string; host: string } }).location
    ;(globalThis as { location?: { protocol: string; host: string } }).location = { protocol: 'https:', host: 'h' }
    try {
      connectAgentSessionStream({
        source: { kind: 'run', runId: 'r' },
        onEvent: () => {},
        WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      })
      expect(FakeWebSocket.instances[0].url).toBe('wss://h/ws/runs/r/agent-session')
    } finally {
      ;(globalThis as { location?: unknown }).location = original
    }
  })

  it('falls back to 127.0.0.1 when location is undefined', () => {
    reset()
    const original = (globalThis as { location?: unknown }).location
    delete (globalThis as { location?: unknown }).location
    try {
      connectAgentSessionStream({
        source: { kind: 'run', runId: 'r' },
        onEvent: () => {},
        WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      })
      expect(FakeWebSocket.instances[0].url.startsWith('ws://127.0.0.1:7421')).toBe(true)
    } finally {
      ;(globalThis as { location?: unknown }).location = original
    }
  })

  it('ignores non-string message payloads', () => {
    reset()
    const onEvent = vi.fn()
    connectAgentSessionStream({
      source: { kind: 'run', runId: 'r' },
      onEvent,
      wsBase: 'ws://h',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    })
    // Non-string `data` should be treated as empty and parsed as failure.
    FakeWebSocket.instances[0].onmessage?.({ data: 42 as unknown as string })
    expect(onEvent).not.toHaveBeenCalled()
  })

  it('close() when socket is already closing does not throw', () => {
    reset()
    const conn = connectAgentSessionStream({
      source: { kind: 'run', runId: 'r' },
      onEvent: () => {},
      wsBase: 'ws://h',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    })
    const ws = FakeWebSocket.instances[0]
    ws.readyState = 2 // CLOSING — outside the `<=1` branch.
    expect(() => conn.close()).not.toThrow()
  })

  it('throws if no WebSocket implementation is available', () => {
    const original = (globalThis as { WebSocket?: typeof WebSocket }).WebSocket
    ;(globalThis as { WebSocket?: typeof WebSocket }).WebSocket = undefined
    try {
      expect(() => connectAgentSessionStream({
        source: { kind: 'run', runId: 'r' },
        onEvent: () => {},
      })).toThrow(/WebSocket implementation not available/)
    } finally {
      ;(globalThis as { WebSocket?: typeof WebSocket }).WebSocket = original
    }
  })
})
