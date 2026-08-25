// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '@/shared/api/client'
import type { BenchmarkIndexEntry, BenchmarkManifest } from '../api/benchmark-types'
import { BenchmarkProvider, useBenchmark, useBenchmarks } from './BenchmarkContext'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// The reducer and frame mapper are covered against the real rules in
// benchmark-state.test.ts. This suite owns the provider: the socket lifecycle
// (connect, reconnect backoff, teardown), the one-shot actions, and the two
// read hooks — none of which the pure module can reach.
vi.mock('@/shared/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/shared/api/client')>('../../../shared/api/client')
  return {
    ...actual,
    startBenchmark: vi.fn(),
    abortBenchmark: vi.fn(),
    getBenchmark: vi.fn(),
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

function entry(over: Partial<BenchmarkIndexEntry> = {}): BenchmarkIndexEntry {
  return {
    benchmarkId: 'bm-1',
    feature: 'checkout',
    status: 'running',
    startedAt: '2026-08-01T00:00:00.000Z',
    ...over,
  } as BenchmarkIndexEntry
}

function manifest(over: Partial<BenchmarkManifest> = {}): BenchmarkManifest {
  return {
    benchmarkId: 'bm-1',
    feature: 'checkout',
    skill: 'canary-lab-run',
    level: 'light',
    iterations: 1,
    agent: 'claude',
    status: 'running',
    ...over,
  } as BenchmarkManifest
}

let container: HTMLDivElement
let root: Root
let benchmarks: ReturnType<typeof useBenchmarks>
let detail: BenchmarkManifest | undefined

function Probe({ detailId }: { detailId?: string | null }) {
  benchmarks = useBenchmarks()
  detail = useBenchmark(detailId)
  return null
}

function mount(opts: { wsUrl?: string; detailId?: string | null; WebSocketImpl?: typeof WebSocket } = {}): void {
  act(() => {
    root.render(
      <BenchmarkProvider
        wsUrl={opts.wsUrl}
        WebSocketImpl={opts.WebSocketImpl ?? (FakeWebSocket as unknown as typeof WebSocket)}
      >
        <Probe detailId={opts.detailId} />
      </BenchmarkProvider>,
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
  vi.mocked(api.startBenchmark).mockReset().mockResolvedValue({ benchmarkId: 'bm-new' } as never)
  vi.mocked(api.abortBenchmark).mockReset().mockResolvedValue({ ok: true } as never)
  vi.mocked(api.getBenchmark).mockReset()
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
  vi.useRealTimers()
})

describe('BenchmarkProvider — socket lifecycle', () => {
  it('derives its URL from the page origin when none is given', () => {
    mount()

    expect(socket().url).toBe(`ws://${window.location.host}/ws/benchmark`)
    expect(benchmarks.connection).toBe('connecting')
  })

  it('falls back to the global WebSocket when the caller injects none', () => {
    // Production never passes WebSocketImpl — the prop is a test seam, so the
    // real default is the one path every other test here overrides.
    const original = globalThis.WebSocket
    ;(globalThis as { WebSocket: unknown }).WebSocket = FakeWebSocket
    try {
      act(() => {
        root.render(
          <BenchmarkProvider wsUrl="ws://test/ws/benchmark">
            <Probe />
          </BenchmarkProvider>,
        )
      })
      expect(socket().url).toBe('ws://test/ws/benchmark')
    } finally {
      ;(globalThis as { WebSocket: unknown }).WebSocket = original
    }
  })

  it('reports the connection live on open', () => {
    mount({ wsUrl: 'ws://test/ws/benchmark' })

    act(() => { socket().onopen?.() })

    expect(benchmarks.connection).toBe('live')
  })

  it('hydrates the index and details from a snapshot frame', () => {
    mount({ wsUrl: 'ws://test/ws/benchmark', detailId: 'bm-1' })

    act(() => {
      socket().fire({ type: 'snapshot', benchmarks: [entry()], details: { 'bm-1': manifest() } })
    })

    expect(benchmarks.benchmarks.map((b) => b.benchmarkId)).toEqual(['bm-1'])
    expect(detail?.benchmarkId).toBe('bm-1')
  })

  it('drops a malformed frame without tearing down the socket', () => {
    mount({ wsUrl: 'ws://test/ws/benchmark' })
    act(() => { socket().fire({ type: 'snapshot', benchmarks: [entry()], details: {} }) })

    act(() => { socket().onmessage?.({ data: 'not json' }) })
    // A non-string payload takes the String() branch and is equally ignored.
    act(() => { socket().onmessage?.({ data: 42 }) })

    expect(benchmarks.benchmarks.map((b) => b.benchmarkId)).toEqual(['bm-1'])
  })

  it('ignores a frame whose type it does not recognise', () => {
    mount({ wsUrl: 'ws://test/ws/benchmark' })
    act(() => { socket().fire({ type: 'snapshot', benchmarks: [entry()], details: {} }) })

    act(() => { socket().fire({ type: 'who-knows' }) })

    expect(benchmarks.benchmarks.map((b) => b.benchmarkId)).toEqual(['bm-1'])
  })

  it('reconnects with growing backoff, and reports disconnected once it maxes out', async () => {
    vi.useFakeTimers()
    mount({ wsUrl: 'ws://test/ws/benchmark' })
    act(() => { socket().onopen?.() })

    act(() => { socket().onclose?.() })
    expect(benchmarks.connection).toBe('reconnecting')

    await act(async () => { await vi.advanceTimersByTimeAsync(500) })
    expect(FakeWebSocket.instances).toHaveLength(2)
    expect(benchmarks.connection).toBe('reconnecting')

    // Only once the backoff has reached its ceiling does the UI admit the
    // server is gone; before that it keeps quietly retrying.
    let waited = 500
    for (let round = 0; round < 6 && benchmarks.connection !== 'disconnected'; round += 1) {
      act(() => { socket().onclose?.() })
      waited = Math.min(waited * 2, 10_000)
      await act(async () => { await vi.advanceTimersByTimeAsync(waited) })
    }

    expect(benchmarks.connection).toBe('disconnected')
  })

  it('schedules a reconnect when the socket cannot even be constructed', async () => {
    vi.useFakeTimers()
    let attempts = 0
    const Flaky = function Flaky(this: FakeWebSocket, url: string) {
      attempts += 1
      if (attempts === 1) throw new Error('connection refused')
      return new FakeWebSocket(url)
    } as unknown as typeof WebSocket
    mount({ wsUrl: 'ws://test/ws/benchmark', WebSocketImpl: Flaky })
    expect(FakeWebSocket.instances).toHaveLength(0)

    await act(async () => { await vi.advanceTimersByTimeAsync(500) })

    expect(attempts).toBe(2)
    expect(FakeWebSocket.instances).toHaveLength(1)
  })

  it('closes the socket on unmount and stops reconnecting', async () => {
    vi.useFakeTimers()
    mount({ wsUrl: 'ws://test/ws/benchmark' })
    act(() => { socket().onclose?.() })

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
    mount({ wsUrl: 'ws://test/ws/benchmark', WebSocketImpl: Stubborn })

    expect(() => act(() => { root.unmount() })).not.toThrow()
  })
})

describe('BenchmarkProvider — actions', () => {
  it('starts a benchmark and returns its id', async () => {
    mount({ wsUrl: 'ws://test/ws/benchmark' })

    let id: string | undefined
    await act(async () => {
      id = await benchmarks.startBenchmark({
        feature: 'checkout', skill: 'canary-lab-run', level: 'light', iterations: 3, agent: 'claude',
      })
    })

    expect(api.startBenchmark).toHaveBeenCalledWith({
      feature: 'checkout', skill: 'canary-lab-run', level: 'light', iterations: 3, agent: 'claude',
    })
    expect(id).toBe('bm-new')
  })

  it('aborts through to the server', async () => {
    mount({ wsUrl: 'ws://test/ws/benchmark' })

    await act(async () => { await benchmarks.abortBenchmark('bm-1') })

    expect(api.abortBenchmark).toHaveBeenCalledWith('bm-1')
  })

  it('hydrates a terminal benchmark the snapshot left out', async () => {
    vi.mocked(api.getBenchmark).mockResolvedValue(manifest({ benchmarkId: 'bm-old', status: 'completed' }) as never)
    mount({ wsUrl: 'ws://test/ws/benchmark', detailId: 'bm-old' })
    expect(detail).toBeUndefined()

    await act(async () => { await benchmarks.loadBenchmark('bm-old') })

    expect(detail?.status).toBe('completed')
  })

  it('leaves the detail unhydrated when the fetch fails', async () => {
    vi.mocked(api.getBenchmark).mockRejectedValue(new Error('404'))
    mount({ wsUrl: 'ws://test/ws/benchmark', detailId: 'bm-old' })

    await act(async () => { await benchmarks.loadBenchmark('bm-old') })

    expect(detail).toBeUndefined()
  })

  it('leaves the detail unhydrated when the server answers with nothing', async () => {
    vi.mocked(api.getBenchmark).mockResolvedValue(undefined as never)
    mount({ wsUrl: 'ws://test/ws/benchmark', detailId: 'bm-old' })

    await act(async () => { await benchmarks.loadBenchmark('bm-old') })

    expect(detail).toBeUndefined()
  })
})

describe('BenchmarkProvider — read hooks', () => {
  it('resolves no manifest without an id', () => {
    mount({ wsUrl: 'ws://test/ws/benchmark', detailId: null })
    act(() => { socket().fire({ type: 'snapshot', benchmarks: [entry()], details: { 'bm-1': manifest() } }) })

    expect(detail).toBeUndefined()
  })

  it('throws when a hook is used outside the provider', () => {
    function Outside() {
      useBenchmarks()
      return null
    }
    expect(() => act(() => { root.render(<Outside />) }))
      .toThrow(/useBenchmarks must be used inside <BenchmarkProvider>/)
  })
})
