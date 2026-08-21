// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '@/shared/api/client'
import type { PortifyIndexEntry, PortifyManifest } from '@/shared/api/client'
import {
  PortifyProvider,
  useActivePortify,
  usePortify,
  usePortifyWorkflow,
} from './PortifyContext'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// The reducer, the frame mapper and `isActivePortify` are covered against the
// real rules in portify-state.test.ts. This suite owns the provider: the socket
// lifecycle (connect, reconnect backoff, teardown), the one-shot actions, and
// the three read hooks — none of which the pure module can reach.
vi.mock('@/shared/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/shared/api/client')>('../../../shared/api/client')
  return {
    ...actual,
    startPortify: vi.fn(),
    getPortify: vi.fn(),
    savePortify: vi.fn(),
    cancelPortify: vi.fn(),
  }
})

class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  closed = false

  constructor(public url: string) {
    FakeWebSocket.instances.push(this)
  }

  close(): void {
    this.closed = true
    this.onclose?.()
  }

  fire(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) })
  }
}

function entry(over: Partial<PortifyIndexEntry> = {}): PortifyIndexEntry {
  return {
    workflowId: 'wf-1',
    feature: 'checkout',
    status: 'editing',
    startedAt: '2026-08-01T00:00:00.000Z',
    ...over,
  } as PortifyIndexEntry
}

function manifest(over: Partial<PortifyManifest> = {}): PortifyManifest {
  return { workflowId: 'wf-1', feature: 'checkout', status: 'editing', ...over } as PortifyManifest
}

let container: HTMLDivElement
let root: Root
type Portify = ReturnType<typeof usePortify>
let portify: Portify
let active: PortifyIndexEntry | undefined
let workflow: PortifyManifest | undefined

function Probe({ detailId }: { detailId?: string | null }) {
  portify = usePortify()
  active = useActivePortify()
  workflow = usePortifyWorkflow(detailId)
  return null
}

function mount(opts: { wsUrl?: string; detailId?: string | null; WebSocketImpl?: typeof WebSocket } = {}): void {
  act(() => {
    root.render(
      <PortifyProvider
        wsUrl={opts.wsUrl}
        WebSocketImpl={opts.WebSocketImpl ?? (FakeWebSocket as unknown as typeof WebSocket)}
      >
        <Probe detailId={opts.detailId} />
      </PortifyProvider>,
    )
  })
}

const socket = (): FakeWebSocket => FakeWebSocket.instances[FakeWebSocket.instances.length - 1]

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  FakeWebSocket.instances = []
  vi.useRealTimers()
  vi.mocked(api.startPortify).mockReset().mockResolvedValue({ workflowId: 'wf-new' } as never)
  vi.mocked(api.getPortify).mockReset()
  vi.mocked(api.savePortify).mockReset().mockResolvedValue(manifest() as never)
  vi.mocked(api.cancelPortify).mockReset().mockResolvedValue(manifest() as never)
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
  vi.useRealTimers()
})

describe('PortifyProvider — socket lifecycle', () => {
  it('derives its URL from the page origin when none is given', () => {
    mount()

    expect(socket().url).toBe(`ws://${window.location.host}/ws/portify`)
    expect(portify.connection).toBe('connecting')
  })

  it('falls back to the global WebSocket when the caller injects none', () => {
    // Production never passes WebSocketImpl — the prop is a test seam, so the
    // real default is the one path every other test here overrides.
    const original = globalThis.WebSocket
    ;(globalThis as { WebSocket: unknown }).WebSocket = FakeWebSocket
    try {
      act(() => {
        root.render(
          <PortifyProvider wsUrl="ws://test/ws/portify">
            <Probe />
          </PortifyProvider>,
        )
      })
      expect(socket().url).toBe('ws://test/ws/portify')
    } finally {
      ;(globalThis as { WebSocket: unknown }).WebSocket = original
    }
  })

  it('honours an explicit URL and reports the connection live on open', () => {
    mount({ wsUrl: 'ws://test/ws/portify' })
    expect(socket().url).toBe('ws://test/ws/portify')

    act(() => { socket().onopen?.() })

    expect(portify.connection).toBe('live')
  })

  it('hydrates the index and details from a snapshot frame', () => {
    mount({ wsUrl: 'ws://test/ws/portify', detailId: 'wf-1' })

    act(() => {
      socket().fire({
        type: 'snapshot',
        workflows: [entry()],
        details: { 'wf-1': manifest() },
      })
    })

    expect(portify.workflows.map((w) => w.workflowId)).toEqual(['wf-1'])
    expect(workflow?.workflowId).toBe('wf-1')
  })

  it('drops a malformed frame without tearing down the socket', () => {
    mount({ wsUrl: 'ws://test/ws/portify' })
    act(() => { socket().fire({ type: 'snapshot', workflows: [entry()], details: {} }) })

    act(() => { socket().onmessage?.({ data: 'not json' }) })
    // A non-string payload takes the String() branch and is equally ignored.
    act(() => { socket().onmessage?.({ data: 42 }) })

    expect(portify.workflows.map((w) => w.workflowId)).toEqual(['wf-1'])
  })

  it('ignores a frame whose type it does not recognise', () => {
    mount({ wsUrl: 'ws://test/ws/portify' })
    act(() => { socket().fire({ type: 'snapshot', workflows: [entry()], details: {} }) })

    act(() => { socket().fire({ type: 'who-knows' }) })

    expect(portify.workflows.map((w) => w.workflowId)).toEqual(['wf-1'])
  })

  it('reconnects with growing backoff, and reports disconnected once it maxes out', async () => {
    vi.useFakeTimers()
    mount({ wsUrl: 'ws://test/ws/portify' })
    act(() => { socket().onopen?.() })

    act(() => { socket().onclose?.() })
    expect(portify.connection).toBe('reconnecting')

    // 500ms → a second socket, and the backoff doubles each round. Only once it
    // has reached the ceiling does the UI admit the server is gone.
    await act(async () => { await vi.advanceTimersByTimeAsync(500) })
    expect(FakeWebSocket.instances).toHaveLength(2)
    expect(portify.connection).toBe('reconnecting')

    let waited = 500
    for (let round = 0; round < 6 && portify.connection !== 'disconnected'; round += 1) {
      act(() => { socket().onclose?.() })
      waited = Math.min(waited * 2, 10_000)
      await act(async () => { await vi.advanceTimersByTimeAsync(waited) })
    }

    expect(portify.connection).toBe('disconnected')
  })

  it('schedules a reconnect when the socket cannot even be constructed', async () => {
    vi.useFakeTimers()
    let attempts = 0
    const Flaky = function Flaky(this: FakeWebSocket, url: string) {
      attempts += 1
      if (attempts === 1) throw new Error('connection refused')
      return new FakeWebSocket(url)
    } as unknown as typeof WebSocket
    mount({ wsUrl: 'ws://test/ws/portify', WebSocketImpl: Flaky })
    expect(FakeWebSocket.instances).toHaveLength(0)

    await act(async () => { await vi.advanceTimersByTimeAsync(500) })

    expect(attempts).toBe(2)
    expect(FakeWebSocket.instances).toHaveLength(1)
  })

  it('closes the socket on unmount and stops reconnecting', async () => {
    vi.useFakeTimers()
    mount({ wsUrl: 'ws://test/ws/portify' })
    const first = socket()
    act(() => { first.onclose?.() })

    act(() => { root.unmount() })
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })

    // The pending reconnect timer was cleared, so teardown is final.
    expect(FakeWebSocket.instances).toHaveLength(1)
  })

  it('survives a socket that throws on close', () => {
    const Stubborn = function Stubborn(this: unknown, url: string) {
      const s = new FakeWebSocket(url)
      s.close = () => { throw new Error('already closed') }
      return s
    } as unknown as typeof WebSocket
    mount({ wsUrl: 'ws://test/ws/portify', WebSocketImpl: Stubborn })

    expect(() => act(() => { root.unmount() })).not.toThrow()
  })
})

describe('PortifyProvider — actions', () => {
  it('starts a workflow and returns its id', async () => {
    mount({ wsUrl: 'ws://test/ws/portify' })

    let id: string | undefined
    await act(async () => { id = await portify.startPortify({ feature: 'checkout', agent: 'claude' }) })

    expect(api.startPortify).toHaveBeenCalledWith({ feature: 'checkout', agent: 'claude' })
    expect(id).toBe('wf-new')
  })

  it('saves and cancels through to the server', async () => {
    mount({ wsUrl: 'ws://test/ws/portify' })

    await act(async () => { await portify.savePortify('wf-1') })
    await act(async () => { await portify.cancelPortify('wf-1') })

    expect(api.savePortify).toHaveBeenCalledWith('wf-1')
    expect(api.cancelPortify).toHaveBeenCalledWith('wf-1')
  })

  it('hydrates a terminal workflow the snapshot left out', async () => {
    vi.mocked(api.getPortify).mockResolvedValue(manifest({ workflowId: 'wf-old', status: 'saved' }) as never)
    mount({ wsUrl: 'ws://test/ws/portify', detailId: 'wf-old' })
    expect(workflow).toBeUndefined()

    await act(async () => { await portify.loadPortify('wf-old') })

    expect(workflow?.status).toBe('saved')
  })

  it('leaves the detail unhydrated when the fetch fails', async () => {
    vi.mocked(api.getPortify).mockRejectedValue(new Error('404'))
    mount({ wsUrl: 'ws://test/ws/portify', detailId: 'wf-old' })

    await act(async () => { await portify.loadPortify('wf-old') })

    expect(workflow).toBeUndefined()
  })

  it('leaves the detail unhydrated when the server answers with nothing', async () => {
    vi.mocked(api.getPortify).mockResolvedValue(undefined as never)
    mount({ wsUrl: 'ws://test/ws/portify', detailId: 'wf-old' })

    await act(async () => { await portify.loadPortify('wf-old') })

    expect(workflow).toBeUndefined()
  })
})

describe('PortifyProvider — read hooks', () => {
  it('exposes the one active workflow, and nothing once it settles', () => {
    mount({ wsUrl: 'ws://test/ws/portify' })

    act(() => {
      socket().fire({
        type: 'snapshot',
        workflows: [entry({ workflowId: 'wf-done', status: 'saved' }), entry({ workflowId: 'wf-live', status: 'editing' })],
        details: {},
      })
    })
    expect(active?.workflowId).toBe('wf-live')

    act(() => { socket().fire({ type: 'removed', workflowId: 'wf-live' }) })

    expect(active).toBeUndefined()
  })

  it('resolves no manifest without an id', () => {
    mount({ wsUrl: 'ws://test/ws/portify', detailId: null })
    act(() => { socket().fire({ type: 'snapshot', workflows: [entry()], details: { 'wf-1': manifest() } }) })

    expect(workflow).toBeUndefined()
  })

  it('throws when a hook is used outside the provider', () => {
    function Outside() {
      usePortify()
      return null
    }
    expect(() => act(() => { root.render(<Outside />) }))
      .toThrow(/usePortify must be used inside <PortifyProvider>/)
  })
})
