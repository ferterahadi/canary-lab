import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { connectReconnectingSocket, defaultWsBase } from './reconnecting-socket'

class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  url: string
  readyState = 0 // CONNECTING
  onmessage?: (ev: { data: string }) => void
  onopen?: () => void
  onclose?: () => void
  onerror?: () => void

  constructor(url: string) {
    this.url = url
    FakeWebSocket.instances.push(this)
  }

  close(): void { this.readyState = 3 }
  send(data: string): void { void data }
}

function reset(): void { FakeWebSocket.instances = [] }

describe('connectReconnectingSocket', () => {
  beforeEach(() => {
    reset()
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('derives websocket bases for server, HTTP, and HTTPS environments', () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'location')
    try {
      delete (globalThis as { location?: Location }).location
      expect(defaultWsBase()).toBe('ws://127.0.0.1:7421')
      Object.defineProperty(globalThis, 'location', {
        value: { protocol: 'http:', host: 'localhost:3000' },
        configurable: true,
      })
      expect(defaultWsBase()).toBe('ws://localhost:3000')
      Object.defineProperty(globalThis, 'location', {
        value: { protocol: 'https:', host: 'canary.example' },
        configurable: true,
      })
      expect(defaultWsBase()).toBe('wss://canary.example')
    } finally {
      if (original) Object.defineProperty(globalThis, 'location', original)
      else delete (globalThis as { location?: Location }).location
    }
  })

  it('fails clearly when no websocket implementation exists', () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket')
    try {
      delete (globalThis as { WebSocket?: typeof WebSocket }).WebSocket
      expect(() => connectReconnectingSocket({
        url: 'ws://host/test',
        onMessage: () => {},
      })).toThrow('WebSocket implementation not available')
    } finally {
      if (original) Object.defineProperty(globalThis, 'WebSocket', original)
    }
  })

  it('delivers messages to onMessage', () => {
    const received: string[] = []
    connectReconnectingSocket({
      url: 'ws://host/test',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      onMessage: (d) => received.push(d),
    })
    const ws = FakeWebSocket.instances[0]
    ws.onmessage?.({ data: 'hello' })
    expect(received).toEqual(['hello'])
  })

  it('drops non-string frames', () => {
    const received: string[] = []
    connectReconnectingSocket({
      url: 'ws://host/test',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      onMessage: (d) => received.push(d),
    })
    const ws = FakeWebSocket.instances[0]
    ws.onmessage?.({ data: 42 as unknown as string })
    expect(received).toEqual([])
  })

  it('coerces non-string frames only when requested', () => {
    const received: string[] = []
    connectReconnectingSocket({
      url: 'ws://host/test', WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      coerceMessageData: true, onMessage: (data) => received.push(data),
    })
    const ws = FakeWebSocket.instances[0]
    ws.onmessage?.({ data: { toString: () => '{"type":"snapshot"}' } as unknown as string })
    ws.onmessage?.({ data: 'unchanged' })
    expect(received).toEqual(['{"type":"snapshot"}', 'unchanged'])
  })

  it('preserves exponential delays, callback order and reset after opening', () => {
    const events: unknown[] = []
    class ObservedSocket extends FakeWebSocket {
      constructor(url: string) { super(url); events.push('constructed') }
    }
    connectReconnectingSocket({
      url: 'ws://host/test', WebSocketImpl: ObservedSocket as unknown as typeof WebSocket,
      maxReconnects: Infinity, onMessage: () => {},
      reconnectDelayMs: (attempt) => Math.min(500 * 2 ** (attempt - 1), 10_000),
      onReconnect: (attempt, reason) => events.push(['scheduled', attempt, reason]),
      onReconnectAttempt: (attempt, delay) => events.push(['retry', attempt, delay]),
    })
    events.length = 0
    const delays = [500, 1000, 2000, 4000, 8000, 10000, 10000]
    for (const [index, delay] of delays.entries()) {
      FakeWebSocket.instances.at(-1)!.onclose?.()
      expect(events).toEqual([['scheduled', index + 1, 'close']])
      vi.advanceTimersByTime(delay - 1)
      expect(FakeWebSocket.instances).toHaveLength(index + 1)
      vi.advanceTimersByTime(1)
      expect(events).toEqual([['scheduled', index + 1, 'close'], ['retry', index + 1, delay], 'constructed'])
      events.length = 0
    }
    FakeWebSocket.instances.at(-1)!.onopen?.()
    FakeWebSocket.instances.at(-1)!.onclose?.()
    vi.advanceTimersByTime(500)
    expect(events).toEqual([['scheduled', 1, 'close'], ['retry', 1, 500], 'constructed'])
  })

  it('distinguishes constructor failures and cancels their pending retry callback', () => {
    class BrokenSocket { constructor() { throw new Error('unavailable') } }
    const scheduled = vi.fn()
    const retry = vi.fn()
    const connection = connectReconnectingSocket({
      url: 'ws://host/test', WebSocketImpl: BrokenSocket as unknown as typeof WebSocket,
      maxReconnects: Infinity, reconnectDelayMs: (attempt) => attempt * 500,
      onMessage: () => {}, onReconnect: scheduled, onReconnectAttempt: retry,
    })
    expect(scheduled).toHaveBeenLastCalledWith(1, 'setup-error')
    vi.advanceTimersByTime(500)
    expect(retry).toHaveBeenCalledWith(1, 500)
    expect(scheduled).toHaveBeenLastCalledWith(2, 'setup-error')
    connection.close()
    vi.advanceTimersByTime(1000)
    expect(retry).toHaveBeenCalledTimes(1)
  })

  it('keeps a finite retry budget across successful opens and supports immediate retry callbacks', () => {
    const retry = vi.fn()
    connectReconnectingSocket({
      url: 'ws://host/test', WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      onMessage: () => {}, onReconnectAttempt: retry,
    })
    FakeWebSocket.instances[0].onopen?.()
    FakeWebSocket.instances[0].onclose?.()
    expect(retry).toHaveBeenCalledWith(1, 0)
    FakeWebSocket.instances[1].onopen?.()
    FakeWebSocket.instances[1].onclose?.()
    expect(FakeWebSocket.instances).toHaveLength(2)
    expect(retry).toHaveBeenCalledTimes(1)
  })

  it('reconnects once on unexpected close (default maxReconnects=1)', () => {
    connectReconnectingSocket({
      url: 'ws://host/test',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      onMessage: () => {},
    })
    expect(FakeWebSocket.instances).toHaveLength(1)
    FakeWebSocket.instances[0].onclose?.()
    expect(FakeWebSocket.instances).toHaveLength(2)
    // Second close exhausts reconnects → no third socket
    FakeWebSocket.instances[1].onclose?.()
    expect(FakeWebSocket.instances).toHaveLength(2)
  })

  it('close() stops reconnects and closes a live socket', () => {
    const sock = connectReconnectingSocket({
      url: 'ws://host/test',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      onMessage: () => {},
    })
    const ws = FakeWebSocket.instances[0]
    ws.readyState = 1 // OPEN
    sock.close()
    expect(ws.readyState).toBe(3) // closed
    // After close, an unexpected close must not reconnect
    ws.onclose?.()
    expect(FakeWebSocket.instances).toHaveLength(1)
  })

  it('close() clears a pending reconnect timer (line 86 true branch)', () => {
    // reconnectDelayMs > 0 → setTimeout is used; calling close() before the timer
    // fires must clearTimeout (line 86 reconnectTimer branch).
    const sock = connectReconnectingSocket({
      url: 'ws://host/test',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      onMessage: () => {},
      maxReconnects: 2,
      reconnectDelayMs: 5000,
    })
    // Trigger an unexpected close → schedules a reconnect timer
    FakeWebSocket.instances[0].onclose?.()
    expect(FakeWebSocket.instances).toHaveLength(1) // not yet reconnected
    // close() before the timer fires → line 86 branch taken
    sock.close()
    // Advance past the timer; must NOT open a second socket
    vi.advanceTimersByTime(10000)
    expect(FakeWebSocket.instances).toHaveLength(1)
  })

  it('close() is a no-op when socket is null (line 87 false branch)', () => {
    const sock = connectReconnectingSocket({
      url: 'ws://host/test',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      onMessage: () => {},
    })
    // Simulate socket closing internally (sets socket = null inside onclose)
    FakeWebSocket.instances[0].onclose?.()
    // Now socket = null (exhausted reconnects) — close() must not throw
    expect(() => sock.close()).not.toThrow()
  })

  it('markDone() stops reconnecting after a close', () => {
    const sock = connectReconnectingSocket({
      url: 'ws://host/test',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      onMessage: () => {},
      maxReconnects: Infinity,
    })
    sock.markDone()
    FakeWebSocket.instances[0].onclose?.()
    expect(FakeWebSocket.instances).toHaveLength(1) // no reconnect
  })

  it('send() delivers a frame when socket is OPEN', () => {
    const sent: string[] = []
    const ws0 = FakeWebSocket.instances[0] ?? null
    connectReconnectingSocket({
      url: 'ws://host/test',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      onMessage: () => {},
    })
    const ws = FakeWebSocket.instances[0]
    ws.readyState = 1 // OPEN
    const origSend = ws.send.bind(ws)
    ws.send = (d: string) => { sent.push(d); origSend(d) }
    const sock = connectReconnectingSocket({
      url: 'ws://host/test2',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      onMessage: () => {},
    })
    const ws2 = FakeWebSocket.instances[FakeWebSocket.instances.length - 1]
    ws2.readyState = 1
    ws2.send = (d: string) => { sent.push(d) }
    sock.send?.('ping')
    expect(sent).toContain('ping')
    void ws0
  })

  it('send() safely ignores closed or non-open sockets and a transport race', () => {
    const sock = connectReconnectingSocket({
      url: 'ws://host/test',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      onMessage: () => {},
      maxReconnects: 0,
    })
    const ws = FakeWebSocket.instances[0]
    expect(() => sock.send('while-connecting')).not.toThrow()
    ws.readyState = 1
    ws.send = () => { throw new Error('closed during send') }
    expect(() => sock.send('transport-race')).not.toThrow()
    ws.onclose?.()
    expect(() => sock.send('after-close')).not.toThrow()
    sock.close()
    expect(() => sock.send('after-explicit-close')).not.toThrow()
  })

  it('onOpen callback fires when socket opens', () => {
    let opened = false
    connectReconnectingSocket({
      url: 'ws://host/test',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      onMessage: () => {},
      onOpen: () => { opened = true },
    })
    FakeWebSocket.instances[0].onopen?.()
    expect(opened).toBe(true)
  })

  it('reports fixed-delay reconnect attempts and resets the count after opening', () => {
    const attempts: number[] = []
    connectReconnectingSocket({
      url: 'ws://host/test',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      onMessage: () => {},
      onReconnect: (attempt) => attempts.push(attempt),
      maxReconnects: Infinity,
      reconnectDelayMs: 500,
    })

    FakeWebSocket.instances[0].onclose?.()
    expect(attempts).toEqual([1])
    vi.advanceTimersByTime(500)
    FakeWebSocket.instances[1].onclose?.()
    expect(attempts).toEqual([1, 2])
    vi.advanceTimersByTime(500)
    FakeWebSocket.instances[2].onopen?.()
    FakeWebSocket.instances[2].onclose?.()
    expect(attempts).toEqual([1, 2, 1])
  })

  it('retries when construction throws instead of crashing the caller', () => {
    class FlakyWebSocket extends FakeWebSocket {
      static attempts = 0

      constructor(url: string) {
        FlakyWebSocket.attempts += 1
        if (FlakyWebSocket.attempts < 3) throw new Error('not listening yet')
        super(url)
      }
    }
    const errors: string[] = []
    const reconnects: number[] = []
    connectReconnectingSocket({
      url: 'ws://host/test',
      WebSocketImpl: FlakyWebSocket as unknown as typeof WebSocket,
      onMessage: () => {},
      onError: (message) => errors.push(message),
      onReconnect: (attempt) => reconnects.push(attempt),
      maxReconnects: Infinity,
      reconnectDelayMs: 500,
    })

    expect(FakeWebSocket.instances).toHaveLength(0)
    vi.advanceTimersByTime(1_000)
    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(errors).toEqual(['socket error', 'socket error'])
    expect(reconnects).toEqual([1, 2])
  })

  it('preserves constructor failures for callers that handle setup errors', () => {
    const failure = new Error('socket unavailable')
    class ThrowingWebSocket {
      constructor() {
        throw failure
      }
    }
    const setupErrors: unknown[] = []
    const transportErrors: string[] = []

    connectReconnectingSocket({
      url: 'ws://host/test',
      WebSocketImpl: ThrowingWebSocket as unknown as typeof WebSocket,
      onMessage: () => {},
      onSetupError: (error) => setupErrors.push(error),
      onError: (message) => transportErrors.push(message),
      maxReconnects: 0,
    })

    expect(setupErrors).toEqual([failure])
    expect(transportErrors).toEqual([])
  })

  it('onError callback fires on socket error', () => {
    const errors: string[] = []
    connectReconnectingSocket({
      url: 'ws://host/test',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      onMessage: () => {},
      onError: (msg) => errors.push(msg),
    })
    FakeWebSocket.instances[0].onerror?.()
    expect(errors).toEqual(['socket error'])
  })
})
