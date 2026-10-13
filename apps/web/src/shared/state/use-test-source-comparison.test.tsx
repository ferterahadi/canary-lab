// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as featuresApi from '../api/features'
import { ApiError } from '../api/internal'
import type { TestSourceComparison } from '@shared/test-review'
import { InvalidationProvider, useInvalidation } from './invalidation'
import { useTestSourceComparison } from './use-test-source-comparison'

vi.mock('../api/features', () => ({
  getTestSourceComparison: vi.fn(),
}))
let root: Root
let live: ReturnType<typeof useTestSourceComparison>
let invalidate: () => void
const ready = (file = 'new.spec.ts'): TestSourceComparison => ({ state: 'ready', files: [file], differences: [], changes: { added: [], changed: [], removed: [] } })
function Probe({ id = 'run', snapshot = '/snapshot' }: { id?: string; snapshot?: string }) {
  const bus = useInvalidation()
  invalidate = () => bus.invalidate('tests')
  live = useTestSourceComparison({ feature: 'shop', runId: id, featureDir: '/suite', snapshotDir: snapshot, refreshKey: 0 })
  return null
}
async function render(id = 'run', snapshot = '/snapshot') {
  await act(async () => root.render(<InvalidationProvider><Probe id={id} snapshot={snapshot} /></InvalidationProvider>))
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.resetAllMocks()
  root = createRoot(document.createElement('div'))
  vi.mocked(featuresApi.getTestSourceComparison).mockResolvedValue(ready())
})
afterEach(() => { act(() => root.unmount()); vi.useRealTimers() })
it('recovers a hung initial read and rejects it after a newer comparison', async () => {
  let late!: (value: TestSourceComparison) => void
  vi.mocked(featuresApi.getTestSourceComparison).mockImplementationOnce(() => new Promise((resolve) => { late = resolve }))
  await render()
  expect(live.comparison.state).toBe('loading')
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
  expect(live.comparison.files).toEqual(['new.spec.ts'])
  await act(async () => late(ready('old.spec.ts')))
  expect(live.comparison.files).toEqual(['new.spec.ts'])
})
it('retains evidence on failure but withdraws action trust, then recovers without events', async () => {
  await render()
  vi.mocked(featuresApi.getTestSourceComparison).mockRejectedValueOnce(new Error('offline'))
  await act(async () => invalidate())
  expect(live.comparison.files).toEqual(['new.spec.ts'])
  expect(live.error).toBeTruthy()
  expect(live.confirmed).toBe(false)
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
  expect(live.confirmed).toBe(true)
  expect(live.error).toBeNull()
})
it.each([404, 409])('clears authoritative missing data (%s) and discovers its restoration', async (status) => {
  await render()
  vi.mocked(featuresApi.getTestSourceComparison).mockRejectedValueOnce(new ApiError(status, null, status === 404 ? 'Suite not found' : 'Snapshot missing'))
  await act(async () => invalidate())
  expect(live.comparison.files).toEqual([])
  expect(live.confirmed).toBe(false)
  expect(status === 404 ? live.missingSuite : live.missingSnapshot).toBe(true)
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
  expect(live.comparison.files).toEqual(['new.spec.ts'])
})
it('recovers failed initial reads and keeps reconciling empty and incomplete results', async () => {
  vi.mocked(featuresApi.getTestSourceComparison).mockRejectedValueOnce(new Error('offline'))
  await render()
  expect(live.comparison.state).toBe('error')
  vi.mocked(featuresApi.getTestSourceComparison).mockResolvedValueOnce({ state: 'unavailable', files: [], differences: [], reasons: ['incomplete'] })
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
  expect(live.comparison.state).toBe('unavailable')
  expect(live.confirmed).toBe(false)
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
  expect(live.confirmed).toBe(true)
})
it('rechecks on reconnect invalidation and rejects results across identity replacement or teardown', async () => {
  let late!: (value: TestSourceComparison) => void
  await render()
  vi.mocked(featuresApi.getTestSourceComparison).mockImplementationOnce(() => new Promise((resolve) => { late = resolve }))
  await act(async () => invalidate())
  await render('replacement', '/other-snapshot')
  await act(async () => late(ready('obsolete.spec.ts')))
  expect(live.comparison.files).toEqual(['new.spec.ts'])
  vi.mocked(featuresApi.getTestSourceComparison).mockImplementationOnce(() => new Promise((resolve) => { late = resolve }))
  await act(async () => invalidate())
  await act(async () => root.render(null))
  const calls = vi.mocked(featuresApi.getTestSourceComparison).mock.calls.length
  await act(async () => { late(ready('late.spec.ts')); await vi.advanceTimersByTimeAsync(30_000) })
  expect(featuresApi.getTestSourceComparison).toHaveBeenCalledTimes(calls)
})
