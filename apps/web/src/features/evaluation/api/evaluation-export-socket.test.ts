import { afterEach, describe, it, expect, vi } from 'vitest'
import { connectEvaluationExport } from './evaluation-export-socket'
import { FakeWebSocket } from '../../../../../../tools/test-helpers/fake-websocket'

const reset = (): void => { FakeWebSocket.instances = [] }

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('connectEvaluationExport', () => {
  it('builds the export task stream URL', () => {
    reset()
    connectEvaluationExport({
      taskId: 'task/1',
      onData: () => {},
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      wsBase: 'ws://test',
    })
    expect(FakeWebSocket.instances[0].url).toBe('ws://test/ws/evaluation-exports/task%2F1')
  })

  it('derives ws:// from the page location when no wsBase is provided', () => {
    reset()
    vi.stubGlobal('location', { protocol: 'http:', host: 'example.test:1234' })
    connectEvaluationExport({
      taskId: 'task-x',
      onData: () => {},
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    })
    expect(FakeWebSocket.instances[0].url).toBe('ws://example.test:1234/ws/evaluation-exports/task-x')
  })

  it('forwards data and exit messages', () => {
    reset()
    const onData = vi.fn()
    const onExit = vi.fn()
    connectEvaluationExport({
      taskId: 'task',
      onData,
      onExit,
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      wsBase: 'ws://test',
    })

    FakeWebSocket.instances[0].fire({ type: 'data', chunk: 'hello' })
    FakeWebSocket.instances[0].fire({ type: 'exit', code: 0 })
    FakeWebSocket.instances[0].fireClose()

    expect(onData).toHaveBeenCalledWith('hello')
    expect(onExit).toHaveBeenCalledWith(0)
    expect(FakeWebSocket.instances).toHaveLength(1)
  })

  it('reconnects once after an unexpected close', () => {
    reset()
    connectEvaluationExport({
      taskId: 'task',
      onData: () => {},
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      wsBase: 'ws://test',
    })

    FakeWebSocket.instances[0].fireClose()
    FakeWebSocket.instances[1].fireClose()

    expect(FakeWebSocket.instances).toHaveLength(2)
  })

  it('reports stream errors', () => {
    reset()
    const onError = vi.fn()
    connectEvaluationExport({
      taskId: 'task',
      onData: () => {},
      onError,
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      wsBase: 'ws://test',
    })

    FakeWebSocket.instances[0].fire({ type: 'error', error: 'missing task' })
    FakeWebSocket.instances[0].fireError()

    expect(onError).toHaveBeenCalledWith('missing task')
    expect(onError).toHaveBeenCalledWith('socket error')
  })

  it('uses default websocket bases and the global WebSocket fallback', () => {
    reset()
    vi.stubGlobal('WebSocket', FakeWebSocket)
    vi.stubGlobal('location', { protocol: 'https:', host: 'secure.example' })

    connectEvaluationExport({ taskId: 'task', onData: () => {} })

    expect(FakeWebSocket.instances[0].url).toBe('wss://secure.example/ws/evaluation-exports/task')
  })

  it('falls back to the local web UI socket base when location is absent', () => {
    reset()
    vi.stubGlobal('location', undefined)

    connectEvaluationExport({
      taskId: 'task',
      onData: () => {},
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    })

    expect(FakeWebSocket.instances[0].url).toBe('ws://127.0.0.1:7421/ws/evaluation-exports/task')
  })

  it('throws when no websocket implementation is available', () => {
    vi.stubGlobal('WebSocket', undefined)

    expect(() => connectEvaluationExport({ taskId: 'task', onData: () => {} })).toThrow(
      'WebSocket implementation not available',
    )
  })

  it('ignores malformed and incomplete messages', () => {
    reset()
    const onData = vi.fn()
    const onExit = vi.fn()
    const onError = vi.fn()
    connectEvaluationExport({
      taskId: 'task',
      onData,
      onExit,
      onError,
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      wsBase: 'ws://test',
    })

    FakeWebSocket.instances[0].onmessage?.({ data: 'not json' } as MessageEvent)
    FakeWebSocket.instances[0].onmessage?.({ data: new Uint8Array() } as MessageEvent)
    FakeWebSocket.instances[0].fire({ type: 'data' })
    FakeWebSocket.instances[0].fire({ type: 'exit', code: '0' })
    FakeWebSocket.instances[0].fire({ type: 'noop' })

    expect(onData).not.toHaveBeenCalled()
    expect(onExit).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
  })

  it('does not reconnect when max reconnects is zero', () => {
    reset()
    connectEvaluationExport({
      taskId: 'task',
      onData: () => {},
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      wsBase: 'ws://test',
      maxReconnects: 0,
    })

    FakeWebSocket.instances[0].fireClose()

    expect(FakeWebSocket.instances).toHaveLength(1)
  })

  it('closes only open sockets and swallows close errors', () => {
    reset()
    const open = connectEvaluationExport({
      taskId: 'task-open',
      onData: () => {},
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      wsBase: 'ws://test',
    })
    FakeWebSocket.instances[0].close = vi.fn(() => { throw new Error('already gone') })
    open.close()
    expect(FakeWebSocket.instances[0].close).toHaveBeenCalled()

    const closed = connectEvaluationExport({
      taskId: 'task-closed',
      onData: () => {},
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      wsBase: 'ws://test',
    })
    FakeWebSocket.instances[1].readyState = 2
    closed.close()
    expect(FakeWebSocket.instances[1].closeCalls).toBe(0)
  })
})

it('survives malformed frames and ignores pane reset without losing reconnect recovery', () => {
  reset()
  const onData = vi.fn(); const onError = vi.fn()
  connectEvaluationExport({ taskId: 'task', wsBase: 'ws://test', WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket, onData, onError })
  const first = FakeWebSocket.instances[0]
  for (const msg of [null, [], { type: 'reset' }, { type: 'exit', code: '0' }, { type: 'data', chunk: {} }]) first.fire(msg)
  first.fire({ type: 'error', error: 1 }); first.fireClose()
  expect(FakeWebSocket.instances).toHaveLength(2)
  const next = FakeWebSocket.instances[1]
  next.fire({ type: 'data', chunk: 'recovered' })
  expect(onData).toHaveBeenCalledExactlyOnceWith('recovered')
  expect(onError).toHaveBeenCalledExactlyOnceWith('unknown error')
  next.fire({ type: 'exit', code: 0 }); next.fireClose()
  expect(FakeWebSocket.instances).toHaveLength(2)
})
