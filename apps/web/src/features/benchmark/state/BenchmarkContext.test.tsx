// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as benchmarkApi from '@/shared/api/benchmark'
import { ApiError } from '@/shared/api/internal'
import { BenchmarkDetail, clearWorktreesAction } from '../components/BenchmarkDetail'
import type { BenchmarkManifest } from '../api/benchmark-types'
import type { BenchmarkIndexEntry } from '@shared/benchmark-index'
import { BenchmarkProvider, useBenchmark, useBenchmarkDetail, useBenchmarks } from './BenchmarkContext'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// The reducer and frame mapper are covered against the real rules in
// benchmark-state.test.ts. This suite owns the provider: the socket lifecycle
// (connect, reconnect backoff, teardown), the one-shot actions, and the two
// read hooks — none of which the pure module can reach.
vi.mock('@/shared/api/benchmark', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/shared/api/benchmark')>()),
  startBenchmark: vi.fn(),
  abortBenchmark: vi.fn(),
  getBenchmark: vi.fn(),
  clearBenchmarkWorktrees: vi.fn(),
}))

class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  closed = false
  readyState = 0

  constructor(public url: string) {
    FakeWebSocket.instances.push(this)
  }

  close(): void {
    this.closed = true
    this.readyState = 3
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
    level: 'med',
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
  vi.mocked(benchmarkApi.startBenchmark).mockReset().mockResolvedValue({ benchmarkId: 'bm-new' } as never)
  vi.mocked(benchmarkApi.abortBenchmark).mockReset().mockResolvedValue({ ok: true } as never)
  vi.mocked(benchmarkApi.getBenchmark).mockReset()
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

  it('preserves exact label timing, keeps retrying at the cap, and resets on open', async () => {
    vi.useFakeTimers()
    mount({ wsUrl: 'ws://test/stream' })
    act(() => { socket().onopen?.() })
    for (const [index, delay] of [500, 1000, 2000, 4000, 8000, 10000, 10000].entries()) {
      act(() => { socket().onclose?.() })
      expect(benchmarks.connection).toBe('reconnecting')
      await act(async () => { await vi.advanceTimersByTimeAsync(delay - 1) })
      expect(benchmarks.connection).toBe('reconnecting')
      expect(FakeWebSocket.instances).toHaveLength(index + 1)
      await act(async () => { await vi.advanceTimersByTimeAsync(1) })
      expect(FakeWebSocket.instances).toHaveLength(index + 2)
      expect(benchmarks.connection).toBe(delay === 10000 ? 'disconnected' : 'reconnecting')
    }
    act(() => { socket().onopen?.() })
    expect(benchmarks.connection).toBe('live')
    act(() => { socket().onclose?.() })
    await act(async () => { await vi.advanceTimersByTimeAsync(499) })
    expect(FakeWebSocket.instances).toHaveLength(8)
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(FakeWebSocket.instances).toHaveLength(9)
  })

  it('keeps the initial label during constructor failures until the capped retry fires', async () => {
    vi.useFakeTimers()
    const Broken = function Broken() { throw new Error('offline') } as unknown as typeof WebSocket
    mount({ wsUrl: 'ws://test/stream', WebSocketImpl: Broken })
    expect(benchmarks.connection).toBe('connecting')
    await act(async () => { await vi.advanceTimersByTimeAsync(25_499) })
    expect(benchmarks.connection).toBe('connecting')
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(benchmarks.connection).toBe('disconnected')
  })

  it('recovers missed changes from a new snapshot and preserves frame coercion', async () => {
    vi.useFakeTimers()
    mount({ wsUrl: 'ws://test/stream', detailId: 'bm-1' })
    act(() => { socket().fire({ type: 'snapshot', benchmarks: [entry()], details: { 'bm-1': manifest() } }) })
    act(() => { socket().onclose?.() })
    await act(async () => { await vi.advanceTimersByTimeAsync(500) })
    const recovered = manifest({ status: 'aborted' })
    act(() => {
      socket().onopen?.()
      socket().onmessage?.({ data: { toString: () => JSON.stringify({
        type: 'snapshot', benchmarks: [entry({ status: 'aborted' })], details: { 'bm-1': recovered },
      }) } })
    })
    expect(benchmarks.connection).toBe('live')
    expect(benchmarks.benchmarks).toHaveLength(1)
    expect(benchmarks.benchmarks[0].status).toBe('aborted')
    expect(detail?.status).toBe('aborted')
    act(() => { socket().fire({ type: 'removed', benchmarkId: 'bm-1' }) })
    expect(benchmarks.benchmarks).toEqual([])
    expect(detail).toBeUndefined()
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
        feature: 'checkout', skill: 'canary-lab-run', level: 'med', iterations: 3, agent: 'claude',
      })
    })

    expect(benchmarkApi.startBenchmark).toHaveBeenCalledWith({
      feature: 'checkout', skill: 'canary-lab-run', level: 'med', iterations: 3, agent: 'claude',
    })
    expect(id).toBe('bm-new')
  })

  it('aborts through to the server', async () => {
    mount({ wsUrl: 'ws://test/ws/benchmark' })

    await act(async () => { await benchmarks.abortBenchmark('bm-1') })

    expect(benchmarkApi.abortBenchmark).toHaveBeenCalledWith('bm-1')
  })

  it('hydrates a terminal benchmark the snapshot left out', async () => {
    vi.mocked(benchmarkApi.getBenchmark).mockResolvedValue(manifest({ benchmarkId: 'bm-old', status: 'done' }) as never)
    mount({ wsUrl: 'ws://test/ws/benchmark', detailId: 'bm-old' })
    expect(detail).toBeUndefined()

    await act(async () => { await benchmarks.loadBenchmark('bm-old') })

    expect(detail?.status).toBe('done')
  })

  it('leaves the detail unhydrated when the fetch fails', async () => {
    vi.mocked(benchmarkApi.getBenchmark).mockRejectedValue(new Error('404'))
    mount({ wsUrl: 'ws://test/ws/benchmark', detailId: 'bm-old' })

    await act(async () => { await benchmarks.loadBenchmark('bm-old') })

    expect(detail).toBeUndefined()
  })

  it('leaves the detail unhydrated when the server answers with nothing', async () => {
    vi.mocked(benchmarkApi.getBenchmark).mockResolvedValue(undefined as never)
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

let hydrated: ReturnType<typeof useBenchmarkDetail>
function Demand({ id = 'bm-1' }: { id?: string }) { hydrated = useBenchmarkDetail(id); return null }
const demand = (id = 'bm-1', count = 1) => act(async () => { root.render(<BenchmarkProvider WebSocketImpl={FakeWebSocket as unknown as typeof WebSocket}>
  {Array.from({ length: count }, (_, key) => <Demand key={key} id={id} />)}
</BenchmarkProvider>) })
function delayed() { let resolve!: (value: BenchmarkManifest) => void; const promise = new Promise<BenchmarkManifest>((yes) => { resolve = yes }); return { promise, resolve } }

it('recovers a failed detail read shared by two consumers and rehydrates terminal reconnect snapshots', async () => {
  vi.useFakeTimers()
  vi.mocked(benchmarkApi.getBenchmark).mockRejectedValueOnce(new Error('offline')).mockResolvedValue(manifest({ status: 'done' }))
  await demand('bm-1', 2)
  expect(hydrated.error).toBe('offline')
  expect(benchmarkApi.getBenchmark).toHaveBeenCalledTimes(1)
  await demand('bm-1', 1)
  await act(async () => { await vi.advanceTimersByTimeAsync(2500) })
  expect(hydrated.manifest?.status).toBe('done')
  expect(benchmarkApi.getBenchmark).toHaveBeenCalledTimes(2)
  await act(async () => { socket().onclose?.(); await vi.advanceTimersByTimeAsync(500) })
  await act(async () => { socket().fire({ type: 'snapshot', benchmarks: [entry({ status: 'done' })], details: {} }) })
  expect(hydrated.manifest?.status).toBe('done')
  expect(benchmarkApi.getBenchmark).toHaveBeenCalledTimes(3)
  await act(async () => { await vi.advanceTimersByTimeAsync(10000) })
  expect(benchmarkApi.getBenchmark).toHaveBeenCalledTimes(3)
})

it('supersedes hung detail reads and cancels demand on identity replacement and teardown', async () => {
  vi.useFakeTimers()
  const old = delayed()
  const current = delayed()
  const replacement = delayed()
  vi.mocked(benchmarkApi.getBenchmark).mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise).mockReturnValueOnce(replacement.promise)
  await demand()
  await act(async () => { await vi.advanceTimersByTimeAsync(2500) })
  await act(async () => { current.resolve(manifest({ status: 'done' })); old.resolve(manifest()) })
  expect(hydrated.manifest?.status).toBe('done')
  await demand('bm-next')
  expect(hydrated.manifest).toBeUndefined()
  await act(async () => { root.render(null) })
  await act(async () => { replacement.resolve(manifest({ benchmarkId: 'bm-next' })); await vi.advanceTimersByTimeAsync(10000) })
  expect(hydrated.manifest).toBeUndefined()
  expect(benchmarkApi.getBenchmark).toHaveBeenCalledTimes(3)
})

it.each(['update', 'removed', 'snapshot'] as const)('rejects HTTP after a newer %s observation', async (type) => {
  vi.useFakeTimers()
  const old = delayed(); vi.mocked(benchmarkApi.getBenchmark).mockReturnValue(old.promise)
  await demand()
  await act(async () => {
    if (type === 'update') socket().fire({ type, benchmarkId: 'bm-1', manifest: manifest({ status: 'done' }) })
    else if (type === 'removed') socket().fire({ type, benchmarkId: 'bm-1' })
    else socket().fire({ type, benchmarks: [], details: {} })
    old.resolve(manifest()); await vi.advanceTimersByTimeAsync(10000)
  })
  expect(hydrated.manifest?.status).toBe(type === 'update' ? 'done' : undefined)
  expect(hydrated.missing).toBe(type !== 'update')
  expect(benchmarkApi.getBenchmark).toHaveBeenCalledTimes(1)
})

it('stops at 404, supports Retry, and accepts stream reappearance', async () => {
  vi.useFakeTimers()
  vi.mocked(benchmarkApi.getBenchmark).mockRejectedValue(new ApiError(404, {}))
  await demand()
  await act(async () => { await vi.advanceTimersByTimeAsync(10000) })
  expect(hydrated.missing).toBe(true)
  expect(benchmarkApi.getBenchmark).toHaveBeenCalledTimes(1)
  vi.mocked(benchmarkApi.getBenchmark).mockResolvedValue(manifest({ status: 'done' }))
  await act(async () => { hydrated.retry() })
  expect(hydrated.manifest?.status).toBe('done')
  await act(async () => { socket().fire({ type: 'removed', benchmarkId: 'bm-1' }) })
  expect(hydrated.missing).toBe(true)
  await act(async () => { socket().fire({ type: 'update', benchmarkId: 'bm-1', manifest: manifest() }) })
  expect(hydrated.missing).toBe(false)
  expect(hydrated.manifest?.status).toBe('running')
})

it('the actual detail view replaces indefinite loading with failure, missing, and Retry', async () => {
  vi.mocked(benchmarkApi.getBenchmark).mockRejectedValueOnce(new Error('offline')).mockRejectedValueOnce(new ApiError(404, {}))
  await act(async () => { root.render(<BenchmarkProvider WebSocketImpl={FakeWebSocket as unknown as typeof WebSocket}>
    <BenchmarkDetail id="bm-1" onClose={vi.fn()} onNew={vi.fn()} />
  </BenchmarkProvider>) })
  expect(container.textContent).toContain('offline')
  await act(async () => { [...container.querySelectorAll('button')].find((b) => b.textContent === 'Retry')!.click() })
  expect(container.textContent).toContain('no longer available')
  vi.mocked(benchmarkApi.getBenchmark).mockResolvedValue(manifest({ status: 'error', error: 'Synthetic outcome', startedAt: '2026-01-01', arms: [], results: [] }))
  await act(async () => { [...container.querySelectorAll('button')].find((b) => b.textContent === 'Retry')!.click() })
  expect(container.textContent).toContain('Synthetic outcome')
})

it.each([[0, '0 B'], [1024, '1 KB'], [Number.NaN, '0 B']] as const)('uses shared units when confirming cleanup of %s bytes', async (bytes, expected) => {
  const confirm = vi.fn(() => false)
  vi.stubGlobal('confirm', confirm)
  vi.mocked(benchmarkApi.clearBenchmarkWorktrees).mockResolvedValue({ freedBytes: bytes, alreadyCleared: false } as Awaited<ReturnType<typeof benchmarkApi.clearBenchmarkWorktrees>>)
  try {
    await clearWorktreesAction('bm-1')
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining(`Reclaims ${expected}.`))
    expect(benchmarkApi.clearBenchmarkWorktrees).toHaveBeenCalledWith('bm-1', false)
  } finally { vi.unstubAllGlobals() }
})

it('renders a zero-byte cleanup receipt instead of hiding its size', async () => {
  vi.mocked(benchmarkApi.getBenchmark).mockResolvedValue(manifest({ status: 'error', error: 'Fixture', startedAt: '2026-01-01', arms: [], results: [], worktreesCleared: true, worktreesClearedBytes: 0 }))
  await act(async () => { root.render(<BenchmarkProvider WebSocketImpl={FakeWebSocket as unknown as typeof WebSocket}>
    <BenchmarkDetail id="bm-1" onClose={vi.fn()} onNew={vi.fn()} />
  </BenchmarkProvider>) })
  expect(container.textContent).toContain('reclaimed 0 B')
})
