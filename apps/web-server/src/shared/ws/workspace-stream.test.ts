import { describe, it, expect, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { workspaceStreamRoutes, type WorkspaceStreamFrame } from './workspace-stream'
import { WorkspaceEventBus } from '../workspace-events'

// Fastify is never booted here: the route body is the whole unit under test, so
// `app.get` just captures the handler and the test drives it with a fake socket.
interface FakeSocket {
  send: (raw: string) => void
  on: (event: string, listener: () => void) => void
}

async function mountRoute(): Promise<{
  open: (socket: FakeSocket) => void
  events: WorkspaceEventBus
}> {
  let handler: ((socket: FakeSocket) => void) | undefined
  const app = {
    get: (path: string, _opts: unknown, fn: (socket: FakeSocket) => void) => {
      expect(path).toBe('/ws/workspace')
      handler = fn
    },
  } as unknown as FastifyInstance
  const events = new WorkspaceEventBus()
  await workspaceStreamRoutes(app, { events })
  if (!handler) throw new Error('route handler was never registered')
  return { open: handler, events }
}

/** A socket that records every frame it was sent, decoded back to an object. */
function recordingSocket(): {
  socket: FakeSocket
  frames: WorkspaceStreamFrame[]
  close: () => void
} {
  const frames: WorkspaceStreamFrame[] = []
  const listeners = new Map<string, () => void>()
  return {
    frames,
    socket: {
      send: (raw) => { frames.push(JSON.parse(raw) as WorkspaceStreamFrame) },
      on: (event, listener) => { listeners.set(event, listener) },
    },
    close: () => listeners.get('close')?.(),
  }
}

describe('workspaceStreamRoutes', () => {
  it('sends a `connected` frame as soon as the socket opens', async () => {
    const { open } = await mountRoute()
    const { socket, frames } = recordingSocket()

    open(socket)

    expect(frames).toEqual([{ type: 'connected' }])
  })

  it('forwards every published workspace event to the socket', async () => {
    const { open, events } = await mountRoute()
    const { socket, frames } = recordingSocket()
    open(socket)

    events.publish({ type: 'feature-created', feature: 'checkout' })
    events.publish({ type: 'feature-renamed', from: 'checkout', to: 'cart' })

    expect(frames).toEqual([
      { type: 'connected' },
      { type: 'feature-created', feature: 'checkout' },
      { type: 'feature-renamed', from: 'checkout', to: 'cart' },
    ])
  })

  it('unsubscribes on close, so a later event reaches no socket', async () => {
    const { open, events } = await mountRoute()
    const { socket, frames, close } = recordingSocket()
    open(socket)

    close()
    events.publish({ type: 'features-changed' })

    expect(frames).toEqual([{ type: 'connected' }])
  })

  it('fans one event out to every connected socket independently', async () => {
    const { open, events } = await mountRoute()
    const a = recordingSocket()
    const b = recordingSocket()
    open(a.socket)
    open(b.socket)

    a.close()
    events.publish({ type: 'version-changed' })

    expect(a.frames).toEqual([{ type: 'connected' }])
    expect(b.frames).toEqual([{ type: 'connected' }, { type: 'version-changed' }])
  })

  it('swallows a send on an already-closed socket instead of throwing', async () => {
    const { open, events } = await mountRoute()
    const send = vi.fn(() => { throw new Error('WebSocket is not open') })
    const socket: FakeSocket = { send, on: () => {} }

    // The `connected` frame itself throws — the handler must still register the
    // subscription, and a later publish must not surface the error either.
    expect(() => open(socket)).not.toThrow()
    expect(() => events.publish({ type: 'flights-changed' })).not.toThrow()
    expect(send).toHaveBeenCalledTimes(2)
  })
})
