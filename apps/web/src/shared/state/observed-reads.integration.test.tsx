// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '@/shared/api/client'
import type { PortifyManifest } from '@/shared/api/client'
import type { RunDetail } from '@/shared/api/types'
import type { BenchmarkManifest } from '@/features/benchmark/api/benchmark-types'
import { PortifyProvider, usePortify } from '@/features/portify/state/PortifyContext'
import { BenchmarkProvider, useBenchmarks } from '@/features/benchmark/state/BenchmarkContext'
import { RunsProvider, useRuns, useRun } from '@/features/runs/state/RunsContext'

vi.mock('@/shared/api/client', async () => ({
  ...await vi.importActual<typeof import('@/shared/api/client')>('@/shared/api/client'),
  getPortify: vi.fn(), getBenchmark: vi.fn(), getRunDetail: vi.fn(),
}))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
class Socket {
  static instances: Socket[] = []
  readyState = 0
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  constructor(public url: string) { Socket.instances.push(this) }
  close() { this.readyState = 3; this.onclose?.() }
  fire(frame: unknown) { this.onmessage?.({ data: JSON.stringify(frame) }) }
}
let root: Root
let host: HTMLDivElement
let portify: ReturnType<typeof usePortify>
let benchmark: ReturnType<typeof useBenchmarks>
let runs: ReturnType<typeof useRuns>
function Probe() { portify = usePortify(); benchmark = useBenchmarks(); runs = useRuns(); return null }
function mount() {
  const WS = Socket as unknown as typeof WebSocket
  act(() => root.render(<RunsProvider WebSocketImpl={WS}><PortifyProvider WebSocketImpl={WS}><BenchmarkProvider WebSocketImpl={WS}><Probe /></BenchmarkProvider></PortifyProvider></RunsProvider>))
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const base = { feature: 'sample', startedAt: '2026-01-01T00:00:00.000Z' }
const cases = [
  {
    name: 'Portify', socket: 'portify', key: 'workflowId', id: 'workflow',
    value: (fresh: boolean) => ({ ...base, workflowId: 'workflow', status: fresh ? 'editing' : 'ready-to-save' }) as PortifyManifest,
    mock: vi.mocked(api.getPortify), load: () => portify.loadPortify('workflow'),
    rows: () => portify.workflows, snapshot: { workflows: [], details: {} },
    update: (manifest: unknown) => ({ type: 'update', workflowId: 'workflow', manifest }),
    status: 'editing',
  },
  {
    name: 'Benchmark', socket: 'benchmark', key: 'benchmarkId', id: 'benchmark',
    value: (fresh: boolean) => ({ ...base, benchmarkId: 'benchmark', status: fresh ? 'done' : 'running' }) as BenchmarkManifest,
    mock: vi.mocked(api.getBenchmark), load: () => benchmark.loadBenchmark('benchmark'),
    rows: () => benchmark.benchmarks, snapshot: { benchmarks: [], details: {} },
    update: (manifest: unknown) => ({ type: 'update', benchmarkId: 'benchmark', manifest }),
    status: 'done',
  },

]
beforeEach(() => {
  for (const c of cases) c.mock.mockReset()
  vi.mocked(api.getRunDetail).mockReset()
  Socket.instances = []
  host = document.createElement('div')
  root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()) })

for (const c of cases) describe(c.name, () => {
  const socket = () => Socket.instances.find(s => s.url.endsWith(`/ws/${c.socket}`))!
  it.each(['update', 'removed', 'snapshot'] as const)('rejects delayed HTTP after %s', async (event) => {
    const old = deferred<never>()
    c.mock.mockReturnValueOnce(old.promise)
    mount()
    const pending = c.load()
    act(() => socket().fire(event === 'update' ? c.update(c.value(true)) : event === 'snapshot' ? { type: 'snapshot', ...c.snapshot } : { type: 'removed', [c.key]: c.id }))
    await act(async () => { old.resolve(c.value(false) as never); await pending })
    if (event === 'update') expect(c.rows()[0]?.status).toBe(c.status)
    else expect(c.rows()).toEqual([])
  })

  it('does not let old completion release a newer pending request', async () => {
    const old = deferred<never>(); const next = deferred<never>()
    c.mock.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise)
    mount()
    const first = c.load()
    await c.load()
    expect(c.mock).toHaveBeenCalledTimes(1)
    act(() => socket().fire({ type: 'removed', [c.key]: c.id }))
    const second = c.load()
    await act(async () => { old.resolve(c.value(false) as never); await first })
    await c.load()
    expect(c.mock).toHaveBeenCalledTimes(2)
    await act(async () => { next.resolve(c.value(true) as never); await second })
    expect(c.rows()[0]?.status).toBe(c.status)
  })

  it('allows retry after a failed read', async () => {
    c.mock.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(c.value(true) as never)
    mount()
    await act(async () => { await c.load() })
    await act(async () => { await c.load() })
    expect(c.rows()[0]?.status).toBe(c.status)
  })

  it('invalidates reads when the provider is unmounted', async () => {
    const old = deferred<never>()
    c.mock.mockReturnValueOnce(old.promise)
    mount()
    const pending = c.load()
    act(() => root.unmount())
    root = createRoot(host)
    mount()
    await act(async () => { old.resolve(c.value(false) as never); await pending })
    expect(c.rows()).toEqual([])
  })
})

// Runs already had ordering protection before extraction. Keep its public
// useRun hydration path as a control alongside the newly protected providers.
it.each(['update', 'removed', 'snapshot'])('Runs rejects late detail after %s', async event => {
  const old = deferred<RunDetail>()
  vi.mocked(api.getRunDetail).mockReturnValueOnce(old.promise)
  const manifest = { ...base, runId: 'run', status: 'running' as const, healCycles: 0, services: [] }
  let selected: ReturnType<typeof useRun>
  function RunProbe() { runs = useRuns(); selected = useRun('run'); return null }
  act(() => root.render(<RunsProvider WebSocketImpl={Socket as unknown as typeof WebSocket}><RunProbe /></RunsProvider>))
  const socket = Socket.instances.find(s => s.url.endsWith('/ws/runs'))!
  act(() => socket.fire({ type: 'snapshot', runs: [manifest], details: {} }))
  expect(api.getRunDetail).toHaveBeenCalledTimes(1)
  act(() => socket.fire(event === 'update'
    ? { type: 'update', runId: 'run', detail: { runId: 'run', manifest: { ...manifest, status: 'passed' } } }
    : event === 'snapshot' ? { type: 'snapshot', runs: [], details: {} } : { type: 'removed', runId: 'run' }))
  await act(async () => old.resolve({ runId: 'run', manifest }))
  if (event === 'update') expect(selected!.status).toBe('passed')
  else { expect(runs.runs).toEqual([]); expect(selected!.detail).toBeUndefined() }
})
