// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ConnectWorkspaceEventsOptions } from '@/shared/api/workspace-socket'
import { useWorkspaceRecords } from './use-workspace-records'

const bus = vi.hoisted(() => ({ options: null as ConnectWorkspaceEventsOptions | null, close: vi.fn() }))
vi.mock('@/shared/api/workspace-socket', () => ({
  connectWorkspaceEvents: (options: ConnectWorkspaceEventsOptions) => {
    bus.options = options
    return { close: bus.close }
  },
}))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Row = { id: string; status: string }
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const list = vi.fn<() => Promise<Row[]>>()
let observed: ReturnType<typeof useWorkspaceRecords<Row>>
let root: Root
let host: HTMLDivElement
const settle = async () => { await act(async () => {}) }
const handshake = () => bus.options!.onEvent({ type: 'connected' })
function Probe() {
  observed = useWorkspaceRecords<Row>({ list, idOf: row => row.id, decode: () => null })
  return null
}
function mount() { act(() => root.render(<Probe />)) }

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  list.mockReset().mockResolvedValue([])
  bus.options = null
  bus.close.mockClear()
  host = document.createElement('div')
  root = createRoot(host)
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
})
afterEach(() => {
  act(() => root.unmount())
  vi.restoreAllMocks()
  vi.useRealTimers()
})

it('subscribes before reading and coalesces initial and duplicate handshakes', async () => {
  list.mockImplementation(async () => { expect(bus.options).not.toBeNull(); return [] })
  mount()
  act(() => { handshake(); handshake() })
  await settle()
  expect(list).toHaveBeenCalledTimes(1)
  act(() => { handshake(); handshake() })
  await settle()
  expect(list).toHaveBeenCalledTimes(2)
  expect(observed.sync).toEqual({ loading: false, stale: false, error: null })
})

it('preserves overlapping updates and deletion tombstones, applies unaffected rows, then reads once more', async () => {
  const pending = deferred<Row[]>()
  list.mockReturnValueOnce(pending.promise).mockResolvedValue([{ id: 'changed', status: 'editing' }])
  mount()
  await settle()
  act(() => {
    observed.upsert({ id: 'changed', status: 'editing' })
    observed.remove('deleted')
  })
  await act(async () => pending.resolve([
    { id: 'changed', status: 'ready-to-save' },
    { id: 'deleted', status: 'running' },
    { id: 'unaffected', status: 'done' },
  ]))
  expect(observed.records).toEqual({ changed: { id: 'changed', status: 'editing' }, unaffected: { id: 'unaffected', status: 'done' } })
  expect(observed.sync.stale).toBe(true)
  await act(async () => { await vi.advanceTimersByTimeAsync(2500) })
  expect(list).toHaveBeenCalledTimes(2)
  expect(observed.records).toEqual({ changed: { id: 'changed', status: 'editing' } })
  expect(observed.sync.stale).toBe(false)
})

it('recovers missed creation, completion and deletion after disconnect', async () => {
  list.mockResolvedValueOnce([{ id: 'complete', status: 'running' }, { id: 'deleted', status: 'running' }])
  mount(); await settle()
  act(() => bus.options!.onDisconnect!())
  expect(observed.sync.stale).toBe(true)
  list.mockResolvedValue([{ id: 'complete', status: 'done' }, { id: 'created', status: 'done' }])
  act(() => { bus.options!.onReconnect!(); handshake() })
  await settle()
  expect(observed.records).toEqual({ complete: { id: 'complete', status: 'done' }, created: { id: 'created', status: 'done' } })
  expect(observed.sync.stale).toBe(false)
})

it('keeps records on failure and clears the error after a successful 2.5 second retry', async () => {
  list.mockResolvedValueOnce([{ id: 'known', status: 'running' }]).mockRejectedValueOnce(new Error('offline')).mockResolvedValue([])
  mount(); await settle()
  act(handshake); await settle()
  expect(observed.records.known.status).toBe('running')
  expect(observed.sync).toEqual({ loading: false, stale: true, error: 'offline' })
  await act(async () => { await vi.advanceTimersByTimeAsync(2499) })
  expect(list).toHaveBeenCalledTimes(2)
  await act(async () => { await vi.advanceTimersByTimeAsync(1) })
  expect(list).toHaveBeenCalledTimes(3)
  expect(observed.records).toEqual({})
  expect(observed.sync).toEqual({ loading: false, stale: false, error: null })
})

it('supersedes hung reads and never accepts an older list after a newer list', async () => {
  const old = deferred<Row[]>()
  list.mockReturnValueOnce(old.promise).mockResolvedValue([{ id: 'new', status: 'done' }])
  mount(); await settle()
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
  expect(observed.records.new.status).toBe('done')
  await act(async () => old.resolve([{ id: 'old', status: 'running' }]))
  expect(Object.keys(observed.records)).toEqual(['new'])
  expect(list).toHaveBeenCalledTimes(2)
})

it('pauses periodic reads while hidden and immediately reconciles on visibility', async () => {
  mount(); await settle()
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
  expect(list).toHaveBeenCalledTimes(1)
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  act(() => document.dispatchEvent(new Event('visibilitychange')))
  await settle()
  expect(list).toHaveBeenCalledTimes(2)
})

it('invalidates detail reads on newer events and accepted lists', async () => {
  mount(); await settle()
  const old = deferred<Row>()
  let pending!: Promise<void>
  act(() => { pending = observed.readRecord('row', () => old.promise) })
  act(() => observed.upsert({ id: 'row', status: 'done' }))
  await act(async () => { old.resolve({ id: 'row', status: 'running' }); await pending })
  expect(observed.records.row.status).toBe('done')
  const next = deferred<Row>()
  act(() => { pending = observed.readRecord('row', () => next.promise); handshake() })
  await settle()
  await act(async () => { next.resolve({ id: 'row', status: 'running' }); await pending })
  expect(observed.records).toEqual({})
})

it('cleans up retry, interval, visibility and late reads on unmount', async () => {
  const pending = deferred<Row[]>()
  list.mockReturnValue(pending.promise)
  mount(); await settle()
  const last = observed.records
  act(() => root.unmount())
  root = createRoot(host)
  await act(async () => {
    pending.resolve([{ id: 'late', status: 'done' }])
    document.dispatchEvent(new Event('visibilitychange'))
    window.dispatchEvent(new Event('online'))
    await vi.advanceTimersByTimeAsync(60_000)
  })
  expect(list).toHaveBeenCalledTimes(1)
  expect(observed.records).toBe(last)
  expect(bus.close).toHaveBeenCalledTimes(1)
})
