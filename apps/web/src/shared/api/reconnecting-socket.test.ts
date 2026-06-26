import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { connectReconnectingSocket } from './reconnecting-socket'

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
