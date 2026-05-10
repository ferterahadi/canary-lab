import { describe, it, expect, vi } from 'vitest'
import { connectDraftAgent } from './draft-socket'

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

describe('connectDraftAgent', () => {
  it('builds URL with draftId encoded under /ws/draft and stage query', () => {
    reset()
    connectDraftAgent({
      draftId: 'd/1',
      stage: 'generating',
      onData: () => {},
      WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
      wsBase: 'ws://test',
    })
    expect(FakeSocket.instances[0].url).toBe('ws://test/ws/draft/d%2F1/agent?stage=generating')
  })

  it('defaults the stream stage to planning', () => {
    reset()
    connectDraftAgent({
      draftId: 'd',
      onData: () => {},
      WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
      wsBase: 'ws://test',
    })
    expect(FakeSocket.instances[0].url).toBe('ws://test/ws/draft/d/agent?stage=planning')
  })

  it('forwards data chunks to onData', () => {
    reset()
    const onData = vi.fn()
    connectDraftAgent({
      draftId: 'd1',
      onData,
      WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
      wsBase: 'ws://x',
    })
    FakeSocket.instances[0].fire({ type: 'data', chunk: 'hi' })
    expect(onData).toHaveBeenCalledWith('hi')
  })

  it('calls onExit and stops reconnecting after exit', () => {
    reset()
    const onExit = vi.fn()
    connectDraftAgent({
      draftId: 'd',
      onData: () => {},
      onExit,
      WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
      wsBase: 'ws://x',
    })
    const sock = FakeSocket.instances[0]
    sock.fire({ type: 'exit', code: 0 })
    sock.fireClose()
    expect(onExit).toHaveBeenCalledWith(0)
    expect(FakeSocket.instances.length).toBe(1)
  })

  it('reconnects once on unexpected close', () => {
    reset()
    connectDraftAgent({
      draftId: 'd',
      onData: () => {},
      WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
      wsBase: 'ws://x',
    })
    FakeSocket.instances[0].fireClose()
    expect(FakeSocket.instances.length).toBe(2)
    FakeSocket.instances[1].fireClose()
    expect(FakeSocket.instances.length).toBe(2)
  })

  it('forwards onError frames and socket errors', () => {
    reset()
    const onError = vi.fn()
    connectDraftAgent({
      draftId: 'd',
      onData: () => {},
      onError,
      WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
      wsBase: 'ws://x',
    })
    FakeSocket.instances[0].fire({ type: 'error', error: 'unknown draft' })
    FakeSocket.instances[0].fireError()
    expect(onError).toHaveBeenCalledWith('unknown draft')
    expect(onError).toHaveBeenCalledWith('socket error')
  })

  it('forwards onError with default message when frame omits error string', () => {
    reset()
    const onError = vi.fn()
    connectDraftAgent({
      draftId: 'd',
      onData: () => {},
      onError,
      WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
      wsBase: 'ws://x',
    })
    FakeSocket.instances[0].fire({ type: 'error' })
    expect(onError).toHaveBeenCalledWith('unknown error')
  })

  it('close() prevents reconnect', () => {
    reset()
    const conn = connectDraftAgent({
      draftId: 'd',
      onData: () => {},
      WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
      wsBase: 'ws://x',
    })
    conn.close()
    FakeSocket.instances[0].fireClose()
    expect(FakeSocket.instances.length).toBe(1)
    expect(FakeSocket.instances[0].closeCalls).toBe(1)
  })

  it('ignores malformed JSON frames', () => {
    reset()
    const onData = vi.fn()
    connectDraftAgent({
      draftId: 'd',
      onData,
      WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
      wsBase: 'ws://x',
    })
    FakeSocket.instances[0].fireRaw('not json')
    expect(onData).not.toHaveBeenCalled()
  })

  it('throws if no WebSocket impl available', () => {
    const original = (globalThis as { WebSocket?: typeof WebSocket }).WebSocket
    delete (globalThis as { WebSocket?: typeof WebSocket }).WebSocket
    try {
      expect(() =>
        connectDraftAgent({ draftId: 'd', onData: () => {} }),
      ).toThrow(/WebSocket/)
    } finally {
      ;(globalThis as { WebSocket?: typeof WebSocket }).WebSocket = original
    }
  })

  it('exit frame without numeric code falls through (no onExit)', () => {
    reset()
    const onExit = vi.fn()
    connectDraftAgent({
      draftId: 'd',
      onData: () => {},
      onExit,
      WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
      wsBase: 'ws://x',
    })
    FakeSocket.instances[0].fire({ type: 'exit' })
    expect(onExit).not.toHaveBeenCalled()
  })

  it('defaults to ws:// under http location', () => {
    reset()
    const orig = (globalThis as { location?: Location }).location
    ;(globalThis as { location?: { protocol: string; host: string } }).location = {
      protocol: 'http:',
      host: 'plain.example',
    }
    try {
      connectDraftAgent({
        draftId: 'd',
        onData: () => {},
        WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
      })
      expect(FakeSocket.instances[0].url.startsWith('ws://plain.example')).toBe(true)
    } finally {
      ;(globalThis as { location?: Location | undefined }).location = orig
    }
  })

  it('falls back to local ws when location is undefined', () => {
    reset()
    const orig = (globalThis as { location?: Location }).location
    delete (globalThis as { location?: Location }).location
    try {
      connectDraftAgent({
        draftId: 'd',
        onData: () => {},
        WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
      })
      expect(FakeSocket.instances[0].url.startsWith('ws://127.0.0.1:7421')).toBe(true)
    } finally {
      ;(globalThis as { location?: Location | undefined }).location = orig
    }
  })

  it('ignores non-string payloads', () => {
    reset()
    const onData = vi.fn()
    connectDraftAgent({
      draftId: 'd',
      onData,
      WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
      wsBase: 'ws://x',
    })
    FakeSocket.instances[0].onmessage?.({ data: new ArrayBuffer(4) } as unknown as MessageEvent)
    expect(onData).not.toHaveBeenCalled()
  })

  it('close() swallows errors from underlying socket.close', () => {
    reset()
    const orig = FakeSocket.prototype.close
    FakeSocket.prototype.close = function () { throw new Error('already gone') }
    try {
      const conn = connectDraftAgent({
        draftId: 'd',
        onData: () => {},
        WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
        wsBase: 'ws://x',
      })
      FakeSocket.instances[0].readyState = 1
      expect(() => conn.close()).not.toThrow()
    } finally {
      FakeSocket.prototype.close = orig
    }
  })

  it('uses default wsBase from globalThis.location when not provided', () => {
    reset()
    const orig = (globalThis as { location?: Location }).location
    ;(globalThis as { location?: { protocol: string; host: string } }).location = {
      protocol: 'https:',
      host: 'example.com',
    }
    try {
      connectDraftAgent({
        draftId: 'd',
        onData: () => {},
        WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
      })
      expect(FakeSocket.instances[0].url).toBe('wss://example.com/ws/draft/d/agent?stage=planning')
    } finally {
      ;(globalThis as { location?: Location | undefined }).location = orig
    }
  })
})
