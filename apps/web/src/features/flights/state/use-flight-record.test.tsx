import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ApiError } from '@/shared/api/internal'
import type { FlightManifest } from '@shared/flights/types'
import { InvalidationProvider, useInvalidation } from '@/shared/state/invalidation'
import { useFlightRecord } from './use-flight-record'

const api = vi.hoisted(() => ({ getFlight: vi.fn() }))
vi.mock('@/shared/api/flights', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/shared/api/flights')>()),
  getFlight: api.getFlight,
}))
let root: Root
let host: HTMLDivElement
let record: ReturnType<typeof useFlightRecord>
let invalidate: ReturnType<typeof useInvalidation>['invalidate']
const manifest = (id = 'one', status = 'running') => ({ flightId: id, status }) as FlightManifest
function Reader({ id, live, missing = false }: { id: string | null; live?: FlightManifest | null; missing?: boolean }) {
  record = useFlightRecord(id, live, missing, 0)
  invalidate = useInvalidation().invalidate
  return <div>{record.missing ? 'Deleted' : record.manifest?.status}</div>
}
const render = (props: Parameters<typeof Reader>[0]) => act(async () => { root.render(<InvalidationProvider><Reader {...props} /></InvalidationProvider>) })
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(0); api.getFlight.mockReset().mockResolvedValue(manifest())
  host = document.createElement('div'); root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); vi.useRealTimers() })

it('uses pushes immediately, avoids duplicate reads, and retires a removed record without retaining its REST snapshot', async () => {
  await render({ id: 'one' }); expect(record.manifest?.status).toBe('running')
  const live = manifest('one', 'paused')
  await render({ id: 'one', live }); expect(host.textContent).toBe('paused')
  await act(async () => { invalidate('flights') })
  expect(api.getFlight).toHaveBeenCalledTimes(1)
  await render({ id: 'one', live: null, missing: true }); expect(host.textContent).toBe('Deleted')
  await advance(60000); expect(api.getFlight).toHaveBeenCalledTimes(1)
  await render({ id: 'one', live }); expect(host.textContent).toBe('paused')
})

it('reconciles a quiet push channel, retains transient failures, and treats only 404 as disappearance', async () => {
  const live = manifest()
  await render({ id: 'one', live }); expect(api.getFlight).not.toHaveBeenCalled()
  api.getFlight.mockRejectedValueOnce(new Error('offline'))
  await advance(30000); expect(host.textContent).toBe('running'); expect(record.error).toBe('offline')
  api.getFlight.mockResolvedValueOnce(manifest('one', 'paused'))
  await advance(30000); expect(host.textContent).toBe('paused')
  api.getFlight.mockRejectedValueOnce(new ApiError(404, {}))
  await advance(30000); expect(host.textContent).toBe('Deleted')
  api.getFlight.mockResolvedValueOnce(manifest('one', 'done'))
  await act(async () => { record.refresh() }); expect(host.textContent).toBe('done')
})

it('does not let a late old read overwrite a newer push or a new selection, and stops on unmount', async () => {
  let finish!: (value: FlightManifest) => void
  api.getFlight.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
  await render({ id: 'one' })
  const live = manifest('one', 'done')
  await render({ id: 'one', live })
  await act(async () => { finish(manifest()) }); expect(host.textContent).toBe('done')
  api.getFlight.mockResolvedValue(manifest('two', 'paused'))
  await render({ id: 'two', live }); expect(record.manifest?.flightId).toBe('two')
  await act(async () => { record.refresh() }); expect(record.manifest?.flightId).toBe('two')
  await render({ id: null }); expect(record.manifest).toBeNull()
  await act(async () => { root.render(null) })
  const count = api.getFlight.mock.calls.length
  await advance(90000); expect(api.getFlight).toHaveBeenCalledTimes(count); expect(vi.getTimerCount()).toBe(0)
})

it('rejects a late 404 when a newer push has restored the flight', async () => {
  let reject!: (error: Error) => void
  api.getFlight.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail }))
  await render({ id: 'one' })
  await render({ id: 'one', live: manifest('one', 'paused') })
  await act(async () => { reject(new ApiError(404, {})) })
  expect(host.textContent).toBe('paused'); expect(record.missing).toBe(false)
})
