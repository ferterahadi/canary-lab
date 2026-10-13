import { describe, it, expect, vi } from 'vitest'
import { connectPane } from './pane-socket'
import { FakeWebSocket } from '../../../../../../tools/test-helpers/fake-websocket'

// Minimal fake WebSocket. Tracks instances so tests can drive the lifecycle
// (message, close, error). Mirrors the surface area connectPane consumes.

const reset = (): void => { FakeWebSocket.instances = [] }

describe('connectPane', () => {
  it('builds the correct URL from runId/paneId and wsBase', () => {
    reset()
    connectPane({
      runId: 'r1',
      paneId: 'service:api',
      onData: () => {},
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      wsBase: 'ws://test',
    })
    expect(FakeWebSocket.instances[0].url).toBe('ws://test/ws/run/r1/pane/service%3Aapi')
  })

  it('forwards data chunks to onData', () => {
    reset()
    const onData = vi.fn()
    connectPane({
      runId: 'r1',
      paneId: 'p',
      onData,
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      wsBase: 'ws://x',
    })
    FakeWebSocket.instances[0].fire({ type: 'data', chunk: 'hello' })
    expect(onData).toHaveBeenCalledWith('hello')
  })

  it('notifies when the socket opens', () => {
    reset()
    const onOpen = vi.fn()
    connectPane({
      runId: 'r1',
      paneId: 'p',
      onData: () => {},
      onOpen,
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      wsBase: 'ws://x',
    })
    FakeWebSocket.instances[0].fireOpen()
    expect(onOpen).toHaveBeenCalledOnce()
  })

  it('forwards reset frames', () => {
    reset()
    const onReset = vi.fn()
    connectPane({
      runId: 'r1',
      paneId: 'p',
      onData: () => {},
      onReset,
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      wsBase: 'ws://x',
    })
    FakeWebSocket.instances[0].fire({ type: 'reset' })
    expect(onReset).toHaveBeenCalledOnce()
  })

  it('calls onExit and stops reconnecting after exit message', () => {
    reset()
    const onExit = vi.fn()
    connectPane({
      runId: 'r1',
      paneId: 'p',
      onData: () => {},
      onExit,
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      wsBase: 'ws://x',
    })
    const sock = FakeWebSocket.instances[0]
    sock.fire({ type: 'exit', code: 0 })
    expect(onExit).toHaveBeenCalledWith(0)
    sock.fireClose()
    expect(FakeWebSocket.instances.length).toBe(1) // no reconnect
  })

  it('reconnects once on unexpected close (no exit seen)', () => {
    reset()
    connectPane({
      runId: 'r1',
      paneId: 'p',
      onData: () => {},
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      wsBase: 'ws://x',
    })
    FakeWebSocket.instances[0].fireClose()
    expect(FakeWebSocket.instances.length).toBe(2)
    // Second close should not spawn a third.
    FakeWebSocket.instances[1].fireClose()
    expect(FakeWebSocket.instances.length).toBe(2)
  })

  it('forwards onError for error frames and socket errors', () => {
    reset()
    const onError = vi.fn()
    connectPane({
      runId: 'r1',
      paneId: 'p',
      onData: () => {},
      onError,
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      wsBase: 'ws://x',
    })
    const sock = FakeWebSocket.instances[0]
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
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      wsBase: 'ws://x',
    })
    conn.close()
    FakeWebSocket.instances[0].fireClose()
    expect(FakeWebSocket.instances.length).toBe(1)
    expect(FakeWebSocket.instances[0].closeCalls).toBe(1)
  })

  it('does not close a socket that is already closing or closed', () => {
    reset()
    const conn = connectPane({
      runId: 'r1',
      paneId: 'p',
      onData: () => {},
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      wsBase: 'ws://x',
    })
    FakeWebSocket.instances[0].readyState = 2
    conn.close()
    expect(FakeWebSocket.instances[0].closeCalls).toBe(0)
  })

  it('ignores malformed JSON frames silently', () => {
    reset()
    const onData = vi.fn()
    connectPane({
      runId: 'r1',
      paneId: 'p',
      onData,
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      wsBase: 'ws://x',
    })
    FakeWebSocket.instances[0].fireRaw('not-json')
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

  it('defaults to wss:// under https location', () => {
    reset()
    const orig = (globalThis as { location?: Location }).location
    ;(globalThis as { location?: { protocol: string; host: string } }).location = {
      protocol: 'https:',
      host: 'secure.example',
    }
    try {
      connectPane({
        runId: 'r',
        paneId: 'p',
        onData: () => {},
        WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      })
      expect(FakeWebSocket.instances[0].url.startsWith('wss://secure.example')).toBe(true)
    } finally {
      ;(globalThis as { location?: Location | undefined }).location = orig
    }
  })

  it('falls back to local ws when location is undefined', () => {
    reset()
    const orig = (globalThis as { location?: Location }).location
    delete (globalThis as { location?: Location }).location
    try {
      connectPane({
        runId: 'r',
        paneId: 'p',
        onData: () => {},
        WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      })
      expect(FakeWebSocket.instances[0].url.startsWith('ws://127.0.0.1:7421')).toBe(true)
    } finally {
      ;(globalThis as { location?: Location | undefined }).location = orig
    }
  })

  it('ignores non-string MessageEvent payloads', () => {
    reset()
    const onData = vi.fn()
    connectPane({
      runId: 'r',
      paneId: 'p',
      onData,
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      wsBase: 'ws://x',
    })
    FakeWebSocket.instances[0].onmessage?.({ data: new ArrayBuffer(4) } as unknown as MessageEvent)
    expect(onData).not.toHaveBeenCalled()
  })

  it('error frame without `error` field uses default message', () => {
    reset()
    const onError = vi.fn()
    connectPane({
      runId: 'r',
      paneId: 'p',
      onData: () => {},
      onError,
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      wsBase: 'ws://x',
    })
    FakeWebSocket.instances[0].fire({ type: 'error' })
    expect(onError).toHaveBeenCalledWith('unknown error')
  })

  it('exit frame without numeric code is ignored', () => {
    reset()
    const onExit = vi.fn()
    connectPane({
      runId: 'r',
      paneId: 'p',
      onData: () => {},
      onExit,
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      wsBase: 'ws://x',
    })
    FakeWebSocket.instances[0].fire({ type: 'exit' })
    expect(onExit).not.toHaveBeenCalled()
  })

  it('close() swallows errors from underlying socket.close', () => {
    reset()
    const orig = FakeWebSocket.prototype.close
    FakeWebSocket.prototype.close = function () { throw new Error('already gone') }
    try {
      const conn = connectPane({
        runId: 'r',
        paneId: 'p',
        onData: () => {},
        WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
        wsBase: 'ws://x',
      })
      FakeWebSocket.instances[0].readyState = 1
      expect(() => conn.close()).not.toThrow()
    } finally {
      FakeWebSocket.prototype.close = orig
    }
  })

  it('sends terminal input only while the socket is open', () => {
    reset()
    const conn = connectPane({
      runId: 'r',
      paneId: 'p',
      onData: () => {},
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      wsBase: 'ws://x',
    })
    conn.sendInput('before-open')
    FakeWebSocket.instances[0].fireOpen()
    conn.sendInput('a')
    conn.close()
    conn.sendInput('after-close')
    expect(FakeWebSocket.instances[0].sent).toEqual([
      JSON.stringify({ type: 'pty-input', chunk: 'a' }),
    ])
  })

  it('sends sanitized terminal resize messages only while the socket is open', () => {
    reset()
    const conn = connectPane({
      runId: 'r',
      paneId: 'p',
      onData: () => {},
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      wsBase: 'ws://x',
    })
    conn.sendResize(80, 24)
    FakeWebSocket.instances[0].fireOpen()
    conn.sendResize(Number.NaN, 24)
    conn.sendResize(80, Number.POSITIVE_INFINITY)
    conn.sendResize(0, 24)
    conn.sendResize(80, -1)
    conn.sendResize(120, 30)
    expect(FakeWebSocket.instances[0].sent).toEqual([
      JSON.stringify({ type: 'pty-resize', cols: 120, rows: 30 }),
    ])
  })

  it('swallows send failures for terminal input and resize', () => {
    reset()
    const orig = FakeWebSocket.prototype.send
    FakeWebSocket.prototype.send = function () { throw new Error('socket closed') }
    try {
      const conn = connectPane({
        runId: 'r',
        paneId: 'p',
        onData: () => {},
        WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
        wsBase: 'ws://x',
      })
      FakeWebSocket.instances[0].fireOpen()
      expect(() => conn.sendInput('a')).not.toThrow()
      expect(() => conn.sendResize(120, 30)).not.toThrow()
    } finally {
      FakeWebSocket.prototype.send = orig
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
        WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      })
      expect(FakeWebSocket.instances[0].url).toBe('ws://127.0.0.1:7421/ws/run/r1/pane/p')
    } finally {
      ;(globalThis as { location?: Location | undefined }).location = orig
    }
  })
})

it('survives malformed frames, preserves reset, and only stops reconnecting on a valid exit', () => {
  reset()
  const onData = vi.fn(); const onError = vi.fn(); const onReset = vi.fn()
  connectPane({ runId: 'r', paneId: 'p', wsBase: 'ws://test', WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket, onData, onError, onReset })
  const first = FakeWebSocket.instances[0]
  for (const msg of [null, [], { type: 'exit', code: '0' }, { type: 'data', chunk: {} }]) first.fire(msg)
  first.fire({ type: 'error', error: {} })
  first.fire({ type: 'reset' })
  first.fireClose()
  expect(FakeWebSocket.instances).toHaveLength(2)
  const next = FakeWebSocket.instances[1]
  next.fire({ type: 'data', chunk: 'recovered' })
  expect(onData).toHaveBeenCalledExactlyOnceWith('recovered')
  expect(onError).toHaveBeenCalledExactlyOnceWith('unknown error')
  expect(onReset).toHaveBeenCalledOnce()
  next.fire({ type: 'exit', code: 0 }); next.fireClose()
  expect(FakeWebSocket.instances).toHaveLength(2)
})
