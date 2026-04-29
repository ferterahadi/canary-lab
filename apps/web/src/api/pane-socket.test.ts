import { describe, it, expect, vi } from 'vitest'
import { connectPane } from './pane-socket'

// Minimal fake WebSocket. Tracks instances so tests can drive the lifecycle
// (message, close, error). Mirrors the surface area connectPane consumes.
class FakeSocket {
  static instances: FakeSocket[] = []
  url: string
  readyState = 0
  onmessage: ((ev: MessageEvent) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  closeCalls = 0
  constructor(url: string) {
    this.url = url
    FakeSocket.instances.push(this)
  }
  send(): void { /* not used */ }
  close(): void {
    this.closeCalls += 1
    this.readyState = 3
  }
  fire(msg: unknown): void {
    this.onmessage?.({ data: JSON.stringify(msg) } as MessageEvent)
  }
  fireRaw(data: string): void {
    this.onmessage?.({ data } as MessageEvent)
  }
  fireClose(): void {
    this.readyState = 3
    this.onclose?.()
  }
  fireError(): void {
    this.onerror?.()
  }
}

const reset = (): void => { FakeSocket.instances = [] }

describe('connectPane', () => {
  it('builds the correct URL from runId/paneId and wsBase', () => {
    reset()
    connectPane({
      runId: 'r1',
      paneId: 'service:api',
      onData: () => {},
      WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
      wsBase: 'ws://test',
    })
    expect(FakeSocket.instances[0].url).toBe('ws://test/ws/run/r1/pane/service%3Aapi')
  })

  it('forwards data chunks to onData', () => {
    reset()
    const onData = vi.fn()
    connectPane({
      runId: 'r1',
      paneId: 'p',
      onData,
      WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
      wsBase: 'ws://x',
    })
    FakeSocket.instances[0].fire({ type: 'data', chunk: 'hello' })
    expect(onData).toHaveBeenCalledWith('hello')
  })

  it('calls onExit and stops reconnecting after exit message', () => {
    reset()
    const onExit = vi.fn()
    connectPane({
      runId: 'r1',
      paneId: 'p',
      onData: () => {},
      onExit,
      WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
      wsBase: 'ws://x',
    })
    const sock = FakeSocket.instances[0]
    sock.fire({ type: 'exit', code: 0 })
    expect(onExit).toHaveBeenCalledWith(0)
    sock.fireClose()
    expect(FakeSocket.instances.length).toBe(1) // no reconnect
  })

  it('reconnects once on unexpected close (no exit seen)', () => {
    reset()
    connectPane({
      runId: 'r1',
      paneId: 'p',
      onData: () => {},
      WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
      wsBase: 'ws://x',
    })
    FakeSocket.instances[0].fireClose()
    expect(FakeSocket.instances.length).toBe(2)
    // Second close should not spawn a third.
    FakeSocket.instances[1].fireClose()
    expect(FakeSocket.instances.length).toBe(2)
  })

  it('forwards onError for error frames and socket errors', () => {
    reset()
    const onError = vi.fn()
    connectPane({
      runId: 'r1',
      paneId: 'p',
      onData: () => {},
      onError,
      WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
      wsBase: 'ws://x',
    })
    const sock = FakeSocket.instances[0]
    sock.fire({ type: 'error', error: 'unknown run' })
    sock.fireError()
    expect(onError).toHaveBeenCalledWith('unknown run')
    expect(onError).toHaveBeenCalledWith('socket error')
  })

  it('close() prevents reconnect even if socket later closes', () => {
    reset()
    const conn = connectPane({
      runId: 'r1',
      paneId: 'p',
      onData: () => {},
      WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
      wsBase: 'ws://x',
    })
    conn.close()
    FakeSocket.instances[0].fireClose()
    expect(FakeSocket.instances.length).toBe(1)
    expect(FakeSocket.instances[0].closeCalls).toBe(1)
  })

  it('ignores malformed JSON frames silently', () => {
    reset()
    const onData = vi.fn()
    connectPane({
      runId: 'r1',
      paneId: 'p',
      onData,
      WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
      wsBase: 'ws://x',
    })
    FakeSocket.instances[0].fireRaw('not-json')
    expect(onData).not.toHaveBeenCalled()
  })

  it('throws if no WebSocket implementation is available', () => {
    const original = (globalThis as { WebSocket?: typeof WebSocket }).WebSocket
    delete (globalThis as { WebSocket?: typeof WebSocket }).WebSocket
    try {
      expect(() =>
        connectPane({ runId: 'r', paneId: 'p', onData: () => {} }),
      ).toThrow(/WebSocket/)
    } finally {
      ;(globalThis as { WebSocket?: typeof WebSocket }).WebSocket = original
    }
  })

  it('uses default wsBase from globalThis.location when not provided', () => {
    reset()
    const orig = (globalThis as { location?: Location }).location
    ;(globalThis as { location?: { protocol: string; host: string } }).location = {
      protocol: 'http:',
      host: '127.0.0.1:7421',
    }
    try {
      connectPane({
        runId: 'r1',
        paneId: 'p',
        onData: () => {},
        WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
      })
      expect(FakeSocket.instances[0].url).toBe('ws://127.0.0.1:7421/ws/run/r1/pane/p')
    } finally {
      ;(globalThis as { location?: Location | undefined }).location = orig
    }
  })
})
