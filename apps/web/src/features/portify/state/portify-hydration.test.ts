import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ApiError } from '@/shared/api/internal'
import type { PortifyManifest } from '@/shared/api/portify'
import { createObservedReads } from '@/shared/state/observed-reads'
import { createRecordIndexHydration } from '@/shared/state/record-index-store'
import { portifyIndex, type PortifyAction } from './portify-state'
import { deferred } from '../../../../../../tools/test-helpers/deferred'

const { reducer: portifyReducer, initialState: initialPortifyState } = portifyIndex

const manifest = (status: PortifyManifest['status'] = 'saved'): PortifyManifest => ({ workflowId: 'wf', feature: 'checkout', status, repos: [], agent: 'codex', branch: 'ports', attempt: 1, maxAttempts: 3, startedAt: '2026-01-01' })

function harness() {
  let state = initialPortifyState
  const reads = createObservedReads()
  const read = vi.fn<() => Promise<PortifyManifest>>().mockResolvedValue(manifest())
  const apply = (action: PortifyAction) => { state = portifyReducer(state, action) }
  const owner = createRecordIndexHydration({ index: portifyIndex, errorMessage: 'Could not load port work', reads, read, apply, hasDetail: (id) => Boolean(state.details[id]) })
  owner.start()
  const stream = (action: PortifyAction) => {
    if (action.type === 'update' || action.type === 'removed') reads.invalidate(action.workflowId)
    else reads.clear()
    apply(action); owner.observe(action)
  }
  return { owner, read, stream, state: () => state }
}
beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

it('shares failed hydration recovery between consumers and stops after success', async () => {
  const { owner, read, state } = harness()
  read.mockRejectedValueOnce(new Error('offline'))
  const leaveA = owner.watch('wf')
  const leaveB = owner.watch('wf')
  await vi.advanceTimersByTimeAsync(0)
  expect(read).toHaveBeenCalledTimes(1)
  expect(owner.snapshot('wf').error).toBe('offline')
  leaveA()
  await vi.advanceTimersByTimeAsync(2500)
  expect(read).toHaveBeenCalledTimes(2)
  expect(state().details.wf.status).toBe('saved')
  await vi.advanceTimersByTimeAsync(10000)
  expect(read).toHaveBeenCalledTimes(2)
  leaveB(); owner.stop()
  expect(vi.getTimerCount()).toBe(0)
})

it('supersedes hung reads and rejects late results after the last consumer leaves', async () => {
  const { owner, read, state } = harness()
  const first = deferred<PortifyManifest>()
  const second = deferred<PortifyManifest>()
  read.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
  const leave = owner.watch('wf')
  await vi.advanceTimersByTimeAsync(2500)
  expect(read).toHaveBeenCalledTimes(2)
  first.resolve(manifest('editing')); await Promise.resolve()
  expect(state().details.wf).toBeUndefined()
  leave(); second.resolve(manifest()); await Promise.resolve()
  expect(state().details.wf).toBeUndefined()
  expect(vi.getTimerCount()).toBe(0)
  owner.stop()
})

it.each(['update', 'removed', 'snapshot'] as const)('a stream %s supersedes HTTP and settles recovery', async (type) => {
  const { owner, read, stream, state } = harness()
  const delayed = deferred<PortifyManifest>(); read.mockReturnValueOnce(delayed.promise)
  owner.watch('wf')
  if (type === 'update') stream({ type, workflowId: 'wf', manifest: manifest() })
  if (type === 'removed') stream({ type, workflowId: 'wf' })
  if (type === 'snapshot') stream({ type, workflows: [], details: {} })
  delayed.resolve(manifest('editing')); await vi.advanceTimersByTimeAsync(10000)
  expect(state().details.wf?.status).toBe(type === 'update' ? 'saved' : undefined)
  expect(read).toHaveBeenCalledTimes(1)
  owner.stop()
})

it('rehydrates terminal details omitted by reconnect and permits 404 reappearance', async () => {
  const { owner, read, stream, state } = harness()
  read.mockRejectedValueOnce(new ApiError(404, null))
  owner.watch('wf'); await vi.advanceTimersByTimeAsync(10000)
  expect(owner.snapshot('wf').status).toBe('missing')
  expect(read).toHaveBeenCalledTimes(1)
  const snapshot = { type: 'snapshot' as const, workflows: [manifest()], details: {} }
  stream(snapshot); await vi.advanceTimersByTimeAsync(0)
  expect(state().details.wf.status).toBe('saved')
  stream(snapshot); await vi.advanceTimersByTimeAsync(0)
  expect(read).toHaveBeenCalledTimes(3)
  read.mockRejectedValueOnce(new ApiError(404, null))
  owner.retry('wf'); await vi.advanceTimersByTimeAsync(0)
  expect(state().details.wf).toBeUndefined()
  expect(state().workflows).toHaveLength(1)
  owner.retry('wf'); await vi.advanceTimersByTimeAsync(0)
  expect(state().details.wf.status).toBe('saved')
  owner.stop()
})

it('provider teardown cancels timers and prevents late callbacks', async () => {
  const { owner, read, state } = harness()
  const delayed = deferred<PortifyManifest>(); read.mockReturnValue(delayed.promise)
  owner.watch('wf'); owner.stop(); delayed.resolve(manifest())
  await vi.advanceTimersByTimeAsync(10000)
  expect(state().details.wf).toBeUndefined()
  expect(vi.getTimerCount()).toBe(0)
})
