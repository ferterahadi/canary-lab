import { describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { activeDetails, registerRecordStream, sendFrame } from './record-stream'

// Fastify is never booted here: the route body is the whole unit under test, so
// `app.get` captures the handler and the test drives it with a fake socket.
interface FakeSocket {
  send: (raw: string) => void
  on: (event: string, listener: () => void) => void
}

type Frame = { type: 'snapshot'; ids: string[] } | { type: 'update'; id: string }
type Event = { id?: string }

function fakeStore() {
  const listeners = new Set<(event: Event) => void>()
  return {
    listeners,
    onEvent: (listener: (event: Event) => void) => { listeners.add(listener) },
    offEvent: (listener: (event: Event) => void) => { listeners.delete(listener) },
    emit: (event: Event) => { for (const listener of listeners) listener(event) },
  }
}

function mount(store: ReturnType<typeof fakeStore>, ids: string[]) {
  let handler: ((socket: FakeSocket) => void) | undefined
  let path: string | undefined
  const app = {
    get: (route: string, _opts: unknown, fn: (socket: FakeSocket) => void) => {
      path = route
      handler = fn
    },
  } as unknown as FastifyInstance
  registerRecordStream<Frame, Event>(app, {
    path: '/ws/things',
    store,
    snapshot: () => ({ type: 'snapshot', ids: [...ids] }),
    frameFor: (event) => (event.id ? { type: 'update', id: event.id } : undefined),
  })
  if (!handler) throw new Error('route handler was never registered')
  return { path, open: handler }
}

function recordingSocket() {
  const frames: Frame[] = []
  let onClose: (() => void) | undefined
  const socket: FakeSocket = {
    send: (raw) => frames.push(JSON.parse(raw) as Frame),
    on: (event, listener) => { if (event === 'close') onClose = listener },
  }
  return { socket, frames, close: () => onClose?.() }
}

describe('registerRecordStream', () => {
  it('sends the snapshot first, then one frame per event that has one', () => {
    const store = fakeStore()
    const ids = ['a']
    const { path, open } = mount(store, ids)
    const client = recordingSocket()
    expect(path).toBe('/ws/things')

    open(client.socket)
    store.emit({ id: 'a' })
    // No frame for an event the stream does not carry — not an empty one.
    store.emit({})

    expect(client.frames).toEqual([
      { type: 'snapshot', ids: ['a'] },
      { type: 'update', id: 'a' },
    ])
  })

  it('takes the snapshot at connect time, not at registration', () => {
    const store = fakeStore()
    const ids: string[] = []
    const { open } = mount(store, ids)
    ids.push('late')
    const client = recordingSocket()

    open(client.socket)

    expect(client.frames).toEqual([{ type: 'snapshot', ids: ['late'] }])
  })

  it('drops the listener on close, so a closed socket gets nothing more', () => {
    const store = fakeStore()
    const { open } = mount(store, [])
    const kept = recordingSocket()
    const closed = recordingSocket()
    open(kept.socket)
    open(closed.socket)

    closed.close()
    store.emit({ id: 'after' })

    expect(store.listeners.size).toBe(1)
    expect(closed.frames).toEqual([{ type: 'snapshot', ids: [] }])
    expect(kept.frames).toEqual([{ type: 'snapshot', ids: [] }, { type: 'update', id: 'after' }])
  })
})

describe('sendFrame', () => {
  it('serializes the frame', () => {
    const sent: string[] = []
    sendFrame({ send: (raw) => sent.push(raw) }, { type: 'connected' })
    expect(sent).toEqual(['{"type":"connected"}'])
  })

  it('swallows a send on a socket that already closed', () => {
    const socket = { send: () => { throw new Error('WebSocket is not open') } }
    expect(() => sendFrame(socket, { type: 'update' })).not.toThrow()
  })
})

describe('activeDetails', () => {
  const entries = [
    { id: 'running', active: true },
    { id: 'done', active: false },
    { id: 'lost', active: true },
  ]

  it('keeps details only for active entries the store still has', () => {
    const asked: string[] = []
    const details = activeDetails(entries, (entry) => entry.active, (entry) => entry.id, (id) => {
      asked.push(id)
      return id === 'lost' ? null : { detailOf: id }
    })

    expect(details).toEqual({ running: { detailOf: 'running' } })
    // A settled entry is never read: that read is what the snapshot skips.
    expect(asked).toEqual(['running', 'lost'])
  })
})
