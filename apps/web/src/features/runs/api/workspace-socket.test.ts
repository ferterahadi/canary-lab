import { afterEach, describe, expect, it, vi } from 'vitest'
import { connectWorkspaceEvents } from './workspace-socket'

class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  readyState = 0
  onmessage: ((event: MessageEvent) => void) | null = null
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  closeCalls = 0
  closeError: Error | null = null

  constructor(public url: string) {
    FakeWebSocket.instances.push(this)
  }

  close(): void {
    this.closeCalls += 1
    this.readyState = 3
    if (this.closeError) throw this.closeError
  }

  fire(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) } as MessageEvent)
  }

  fireRaw(data: unknown): void {
    this.onmessage?.({ data } as MessageEvent)
  }

  fireOpen(): void {
    this.readyState = 1
    this.onopen?.()
  }

  fireClose(): void {
    this.readyState = 3
    this.onclose?.()
  }
}

function reset(): void {
  FakeWebSocket.instances = []
}

afterEach(() => {
  vi.useRealTimers()
})

describe('connectWorkspaceEvents', () => {
  it('opens the workspace stream and forwards valid events', () => {
    reset()
    const onEvent = vi.fn()

    connectWorkspaceEvents({
      wsBase: 'ws://test',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      onEvent,
    })
    FakeWebSocket.instances[0].fire({ type: 'features-changed' })
    FakeWebSocket.instances[0].fireRaw('not-json')
    FakeWebSocket.instances[0].fireRaw(new ArrayBuffer(4))

    expect(FakeWebSocket.instances[0].url).toBe('ws://test/ws/workspace')
    expect(onEvent).toHaveBeenCalledOnce()
    expect(onEvent).toHaveBeenCalledWith({ type: 'features-changed' })
  })

  it('reconnects indefinitely after an unexpected close and fires onReconnect (not on first open)', () => {
    reset()
    vi.useFakeTimers()
    const onReconnect = vi.fn()
    connectWorkspaceEvents({
      wsBase: 'ws://test',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      onEvent: () => {},
      onReconnect,
    })

    FakeWebSocket.instances[0].fireOpen()
    expect(onReconnect).not.toHaveBeenCalled() // first open is not a reconnect

    // Drop → a reconnect is scheduled (delayed), then re-opens.
    FakeWebSocket.instances[0].fireClose()
    expect(FakeWebSocket.instances).toHaveLength(1)
    vi.advanceTimersByTime(1500)
    expect(FakeWebSocket.instances).toHaveLength(2)
    FakeWebSocket.instances[1].fireOpen()
    expect(onReconnect).toHaveBeenCalledOnce()

    // A second drop reconnects again — the bus never gives up.
    FakeWebSocket.instances[1].fireClose()
    vi.advanceTimersByTime(1500)
    expect(FakeWebSocket.instances).toHaveLength(3)
  })

  it('stops reconnecting after close()', () => {
    reset()
    vi.useFakeTimers()
    const connection = connectWorkspaceEvents({
      wsBase: 'ws://test',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      onEvent: () => {},
    })
    connection.close()
    FakeWebSocket.instances[0].fireClose()
    vi.advanceTimersByTime(5000)
    expect(FakeWebSocket.instances).toHaveLength(1)
  })

  it('reports socket errors and swallows close failures', () => {
    reset()
    const onError = vi.fn()
    const connection = connectWorkspaceEvents({
      wsBase: 'ws://test',
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      onEvent: () => {},
      onError,
    })
    FakeWebSocket.instances[0].onerror?.()
    FakeWebSocket.instances[0].closeError = new Error('already closed')

    expect(() => connection.close()).not.toThrow()
    expect(onError).toHaveBeenCalledWith('unknown error')
  })

  it('throws when no WebSocket implementation is available', () => {
    const original = (globalThis as { WebSocket?: typeof WebSocket }).WebSocket
    ;(globalThis as { WebSocket?: typeof WebSocket }).WebSocket = undefined
    try {
      expect(() => connectWorkspaceEvents({ onEvent: () => {} })).toThrow(/WebSocket implementation not available/)
    } finally {
      ;(globalThis as { WebSocket?: typeof WebSocket }).WebSocket = original
    }
  })

  it('derives a local websocket base without a page location', () => {
    reset()
    const original = (globalThis as { location?: Location }).location
    delete (globalThis as { location?: Location }).location
    try {
      connectWorkspaceEvents({
        WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
        onEvent: () => {},
      })
      expect(FakeWebSocket.instances[0].url).toBe('ws://127.0.0.1:7421/ws/workspace')
    } finally {
      ;(globalThis as { location?: Location | undefined }).location = original
    }
  })

  it('derives wss:// under https locations', () => {
    reset()
    const original = (globalThis as { location?: Location }).location
    ;(globalThis as { location?: { protocol: string; host: string } }).location = {
      protocol: 'https:',
      host: 'secure.example',
    }
    try {
      connectWorkspaceEvents({
        WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
        onEvent: () => {},
      })
      expect(FakeWebSocket.instances[0].url).toBe('wss://secure.example/ws/workspace')
    } finally {
      ;(globalThis as { location?: Location | undefined }).location = original
    }
  })

  it('derives ws:// under http locations', () => {
    reset()
    const original = (globalThis as { location?: Location }).location
    ;(globalThis as { location?: { protocol: string; host: string } }).location = {
      protocol: 'http:',
      host: 'local.example',
    }
    try {
      connectWorkspaceEvents({
        WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
        onEvent: () => {},
      })
      expect(FakeWebSocket.instances[0].url).toBe('ws://local.example/ws/workspace')
    } finally {
      ;(globalThis as { location?: Location | undefined }).location = original
    }
  })
})
