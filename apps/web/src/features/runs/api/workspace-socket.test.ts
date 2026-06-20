import { describe, expect, it, vi } from 'vitest'
import { connectWorkspaceEvents } from './workspace-socket'

class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: (() => void) | null = null
  closeCalls = 0
  closeError: Error | null = null

  constructor(public url: string) {
    FakeWebSocket.instances.push(this)
  }

  close(): void {
    this.closeCalls += 1
    if (this.closeError) throw this.closeError
  }

  fire(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) } as MessageEvent)
  }

  fireRaw(data: unknown): void {
    this.onmessage?.({ data } as MessageEvent)
  }
}

function reset(): void {
  FakeWebSocket.instances = []
}

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

  it('derives a local websocket base without window', () => {
    reset()
    const originalWindow = (globalThis as { window?: unknown }).window
    delete (globalThis as { window?: unknown }).window
    try {
      connectWorkspaceEvents({
        WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
        onEvent: () => {},
      })
      expect(FakeWebSocket.instances[0].url).toBe('ws://127.0.0.1:7421/ws/workspace')
    } finally {
      ;(globalThis as { window?: unknown }).window = originalWindow
    }
  })

  it('derives wss:// under https windows', () => {
    reset()
    const originalWindow = (globalThis as { window?: unknown }).window
    ;(globalThis as { window?: { location: { protocol: string; host: string } } }).window = {
      location: { protocol: 'https:', host: 'secure.example' },
    }
    try {
      connectWorkspaceEvents({
        WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
        onEvent: () => {},
      })
      expect(FakeWebSocket.instances[0].url).toBe('wss://secure.example/ws/workspace')
    } finally {
      ;(globalThis as { window?: unknown }).window = originalWindow
    }
  })

  it('derives ws:// under http windows', () => {
    reset()
    const originalWindow = (globalThis as { window?: unknown }).window
    ;(globalThis as { window?: { location: { protocol: string; host: string } } }).window = {
      location: { protocol: 'http:', host: 'local.example' },
    }
    try {
      connectWorkspaceEvents({
        WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
        onEvent: () => {},
      })
      expect(FakeWebSocket.instances[0].url).toBe('ws://local.example/ws/workspace')
    } finally {
      ;(globalThis as { window?: unknown }).window = originalWindow
    }
  })
})
