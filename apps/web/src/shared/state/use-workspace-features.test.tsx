import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Feature } from '../api/types'
import { InvalidationProvider, useInvalidation } from './invalidation'
import { useWorkspaceFeatures } from './use-workspace-features'

const api = vi.hoisted(() => ({ listFeatures: vi.fn() }))
vi.mock('../api/client', () => api)

const feature = (name: string): Feature => ({ name, repos: [], envs: [] })
const initial = vi.fn()
const refreshed = vi.fn()
let root: Root
let container: HTMLDivElement
let data: ReturnType<typeof useWorkspaceFeatures>
let invalidate: ReturnType<typeof useInvalidation>['invalidate']

function Probe() {
  ;({ invalidate } = useInvalidation())
  data = useWorkspaceFeatures(initial, refreshed)
  return <output>{data.features.map((entry) => entry.name).join(',')}</output>
}
async function mount() {
  await act(async () => root.render(<InvalidationProvider><Probe /></InvalidationProvider>))
}
async function tick() { await act(async () => vi.advanceTimersByTimeAsync(10_000)) }
function deferred() {
  let resolve!: (features: Feature[]) => void
  const promise = new Promise<Feature[]>((done) => { resolve = done })
  return { promise, resolve }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.resetAllMocks()
  api.listFeatures.mockResolvedValue([feature('checkout')])
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
})

it('retries a failed initial load, initializes once, then reconciles successful reads', async () => {
  api.listFeatures.mockRejectedValueOnce(new Error('offline'))
  await mount()
  expect(container.textContent).toBe('')
  expect(initial).not.toHaveBeenCalled()
  await tick()
  expect(initial).toHaveBeenCalledExactlyOnceWith([feature('checkout')])
  expect(refreshed).not.toHaveBeenCalled()
  await tick()
  expect(initial).toHaveBeenCalledTimes(1)
  expect(refreshed).toHaveBeenCalledExactlyOnceWith([feature('checkout')], undefined)
  expect(api.listFeatures).toHaveBeenCalledTimes(3)
})

it('retains a failed refresh preference until recovery, then consumes it', async () => {
  await mount()
  api.listFeatures.mockRejectedValueOnce(new Error('offline'))
  await act(async () => data.refreshFeatures('renamed'))
  expect(container.textContent).toBe('checkout')
  expect(refreshed).not.toHaveBeenCalled()
  api.listFeatures.mockResolvedValue([feature('renamed')])
  await tick()
  expect(refreshed).toHaveBeenLastCalledWith([feature('renamed')], 'renamed')
  await tick()
  expect(refreshed).toHaveBeenLastCalledWith([feature('renamed')], undefined)
  expect(api.listFeatures).toHaveBeenCalledTimes(4)
})

it('does not let a delayed initial response restore a deleted suite or reinitialize selection', async () => {
  const old = deferred()
  api.listFeatures.mockReturnValueOnce(old.promise)
  await mount()
  api.listFeatures.mockResolvedValue([feature('remaining')])
  await act(async () => data.refreshFeatures())
  expect(container.textContent).toBe('remaining')
  await act(async () => old.resolve([feature('deleted')]))
  expect(container.textContent).toBe('remaining')
  expect(initial).not.toHaveBeenCalled()
  expect(refreshed).toHaveBeenCalledExactlyOnceWith([feature('remaining')], undefined)
})

it.each(['event', 'timer'] as const)('ignores an older %s read after a newer recovery response', async (first) => {
  await mount()
  const old = deferred()
  api.listFeatures.mockReturnValueOnce(old.promise).mockResolvedValue([feature('remaining')])
  if (first === 'event') {
    await act(async () => data.refreshFeatures('remaining'))
    await tick()
  } else {
    await tick()
    await act(async () => data.refreshFeatures('remaining'))
  }
  expect(container.textContent).toBe('remaining')
  await act(async () => old.resolve([feature('deleted')]))
  expect(container.textContent).toBe('remaining')
  expect(refreshed).toHaveBeenCalledExactlyOnceWith([feature('remaining')], 'remaining')
})

it('retains the last confirmed list when the latest read fails and an older one resolves', async () => {
  await mount()
  const old = deferred()
  api.listFeatures.mockReturnValueOnce(old.promise).mockRejectedValueOnce(new Error('offline'))
  await tick()
  await act(async () => data.refreshFeatures())
  await act(async () => old.resolve([feature('stale')]))
  expect(container.textContent).toBe('checkout')
  expect(refreshed).not.toHaveBeenCalled()
  api.listFeatures.mockResolvedValue([])
  await tick()
  expect(container.textContent).toBe('')
  expect(refreshed).toHaveBeenCalledExactlyOnceWith([], undefined)
})

it('keeps refresh callbacks stable and does not refetch on unrelated renders', async () => {
  await mount()
  const refresh = data.refreshFeatures
  await mount()
  expect(data.refreshFeatures).toBe(refresh)
  expect(api.listFeatures).toHaveBeenCalledTimes(1)
  await act(async () => invalidate('features'))
  expect(api.listFeatures).toHaveBeenCalledTimes(2)
  expect(data.refreshFeatures).toBe(refresh)
  expect(initial).toHaveBeenCalledTimes(1)
})

it('preserves a newer refresh requested by a selection callback', async () => {
  await mount()
  refreshed.mockImplementationOnce(() => data.refreshFeatures('next'))
  await act(async () => data.refreshFeatures('first'))
  expect(refreshed.mock.calls).toEqual([[ [feature('checkout')], 'first' ], [ [feature('checkout')], 'next' ]])
  await tick()
  expect(refreshed).toHaveBeenLastCalledWith([feature('checkout')], undefined)
})

it('reconciles on focus and online, then releases timers, listeners and late responses on unmount', async () => {
  await mount()
  api.listFeatures.mockResolvedValue([feature('changed')])
  await act(async () => window.dispatchEvent(new Event('focus')))
  expect(container.textContent).toBe('changed')
  await act(async () => window.dispatchEvent(new Event('online')))
  expect(api.listFeatures).toHaveBeenCalledTimes(3)
  const old = deferred()
  api.listFeatures.mockReturnValueOnce(old.promise)
  await tick()
  const reads = api.listFeatures.mock.calls.length
  const reconciliations = refreshed.mock.calls.length
  act(() => root.unmount())
  expect(vi.getTimerCount()).toBe(0)
  await act(async () => {
    old.resolve([feature('late')])
    window.dispatchEvent(new Event('focus'))
    window.dispatchEvent(new Event('online'))
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(30_000)
  })
  expect(api.listFeatures).toHaveBeenCalledTimes(reads)
  expect(refreshed).toHaveBeenCalledTimes(reconciliations)
})
