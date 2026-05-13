import { describe, it, expect, vi } from 'vitest'
import { connectEvaluationExport } from './evaluation-export-socket'

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
  fireClose(): void {
    this.readyState = 3
    this.onclose?.()
  }
  fireError(): void {
    this.onerror?.()
  }
}

const reset = (): void => { FakeSocket.instances = [] }

describe('connectEvaluationExport', () => {
  it('builds the export task stream URL', () => {
    reset()
    connectEvaluationExport({
      taskId: 'task/1',
      onData: () => {},
      WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
      wsBase: 'ws://test',
    })
    expect(FakeSocket.instances[0].url).toBe('ws://test/ws/evaluation-exports/task%2F1')
  })

  it('forwards data and exit messages', () => {
    reset()
    const onData = vi.fn()
    const onExit = vi.fn()
    connectEvaluationExport({
      taskId: 'task',
      onData,
      onExit,
      WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
      wsBase: 'ws://test',
    })

    FakeSocket.instances[0].fire({ type: 'data', chunk: 'hello' })
    FakeSocket.instances[0].fire({ type: 'exit', code: 0 })
    FakeSocket.instances[0].fireClose()

    expect(onData).toHaveBeenCalledWith('hello')
    expect(onExit).toHaveBeenCalledWith(0)
    expect(FakeSocket.instances).toHaveLength(1)
  })

  it('reconnects once after an unexpected close', () => {
    reset()
    connectEvaluationExport({
      taskId: 'task',
      onData: () => {},
      WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
      wsBase: 'ws://test',
    })

    FakeSocket.instances[0].fireClose()
    FakeSocket.instances[1].fireClose()

    expect(FakeSocket.instances).toHaveLength(2)
  })

  it('reports stream errors', () => {
    reset()
    const onError = vi.fn()
    connectEvaluationExport({
      taskId: 'task',
      onData: () => {},
      onError,
      WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
      wsBase: 'ws://test',
    })

    FakeSocket.instances[0].fire({ type: 'error', error: 'missing task' })
    FakeSocket.instances[0].fireError()

    expect(onError).toHaveBeenCalledWith('missing task')
    expect(onError).toHaveBeenCalledWith('socket error')
  })
})
