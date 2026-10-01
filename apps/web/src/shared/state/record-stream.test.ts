import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { connectRecordStream } from './record-stream'
import { createObservedReads } from './observed-reads'

class Socket {
  static instances: Socket[] = []
  onopen?: () => void
  onclose?: () => void
  onmessage?: (event: { data: unknown }) => void
  readyState = 0
  constructor(readonly url: string) { Socket.instances.push(this) }
  close() { this.readyState = 3; this.onclose?.() }
  fire(frame: unknown) { this.onmessage?.({ data: JSON.stringify(frame) }) }
}
type Action = { type: 'snapshot' } | { type: 'update' | 'removed'; id: string }
const reads = createObservedReads()
let dispatch: ReturnType<typeof vi.fn<(action: Action) => void>>
let onConnection: ReturnType<typeof vi.fn<(status: 'live' | 'reconnecting' | 'disconnected') => void>>
let connection: ReturnType<typeof connectRecordStream>
function connect(WebSocketImpl = Socket as unknown as typeof WebSocket) {
  connection = connectRecordStream<Action>({
    url: 'ws://synthetic/records', WebSocketImpl, reads, dispatch, onConnection,
    decode: (frame) => {
      const value = frame as Action | null
      return value?.type === 'snapshot' || value?.type === 'update' || value?.type === 'removed' ? value : null
    },
    recordId: (action) => action.type === 'snapshot' ? null : action.id,
  })
  return Socket.instances.at(-1)!
}
beforeEach(() => { vi.useFakeTimers(); Socket.instances = []; reads.clear(); dispatch = vi.fn(); onConnection = vi.fn() })
afterEach(() => { connection.close(); vi.useRealTimers() })
it('invalidates only the observed record, and all reads on snapshot/teardown', () => {
  const socket = connect()
  const one = reads.begin('one')!
  const two = reads.begin('two')!
  socket.fire({ type: 'update', id: 'one' })
  expect(reads.current('one', one)).toBe(false)
  expect(reads.current('two', two)).toBe(true)
  const newer = reads.begin('one')!
  reads.finish('one', one)
  expect(reads.current('one', newer)).toBe(true)
  socket.fire({ type: 'removed', id: 'one' })
  expect(reads.current('one', newer)).toBe(false)
  socket.fire({ type: 'snapshot' })
  expect(reads.current('two', two)).toBe(false)
  const last = reads.begin('two')!
  connection.close()
  expect(reads.current('two', last)).toBe(false)
  expect(dispatch.mock.calls.map(([action]) => action.type)).toEqual(['update', 'removed', 'snapshot'])
})
it('ignores malformed/unknown frames and preserves legacy message coercion', () => {
  const socket = connect()
  const token = reads.begin('one')!
  socket.onmessage?.({ data: 'not json' })
  socket.fire(null)
  socket.fire({ type: 'unrecognized' })
  expect(dispatch).not.toHaveBeenCalled()
  expect(reads.current('one', token)).toBe(true)
  socket.onmessage?.({ data: { toString: () => JSON.stringify({ type: 'snapshot' }) } })
  expect(dispatch).toHaveBeenCalledExactlyOnceWith({ type: 'snapshot' })
})
it('preserves capped backoff, label timing, unlimited retries, and reset on open', () => {
  let socket = connect()
  socket.onopen?.()
  expect(onConnection).toHaveBeenLastCalledWith('live')
  for (const delay of [500, 1000, 2000, 4000, 8000, 10_000, 10_000]) {
    socket.close()
    expect(onConnection).toHaveBeenLastCalledWith('reconnecting')
    const count = Socket.instances.length
    vi.advanceTimersByTime(delay - 1)
    expect(Socket.instances).toHaveLength(count)
    expect(onConnection).toHaveBeenLastCalledWith('reconnecting')
    vi.advanceTimersByTime(1)
    expect(Socket.instances).toHaveLength(count + 1)
    if (delay === 10_000) expect(onConnection).toHaveBeenLastCalledWith('disconnected')
    socket = Socket.instances.at(-1)!
  }
  socket.onopen?.(); socket.close()
  const count = Socket.instances.length
  vi.advanceTimersByTime(500)
  expect(Socket.instances).toHaveLength(count + 1)
})
it('retries setup failures without changing their existing label policy', () => {
  let attempts = 0
  class Unavailable { constructor() { attempts++; throw new Error('unavailable') } }
  connect(Unavailable as unknown as typeof WebSocket)
  expect(onConnection).not.toHaveBeenCalled()
  vi.advanceTimersByTime(25_500)
  expect(attempts).toBe(7)
  expect(onConnection).toHaveBeenCalledExactlyOnceWith('disconnected')
})
it('drops captured callbacks and pending reconnects after cleanup', () => {
  const socket = connect()
  const message = socket.onmessage!
  const open = socket.onopen!
  socket.close()
  connection.close()
  onConnection.mockClear()
  message({ data: JSON.stringify({ type: 'update', id: 'late' }) }); open()
  vi.advanceTimersByTime(60_000)
  expect(dispatch).not.toHaveBeenCalled()
  expect(onConnection).not.toHaveBeenCalled()
  expect(Socket.instances).toHaveLength(1)
})
