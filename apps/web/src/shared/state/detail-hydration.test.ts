import { afterEach, expect, it, vi } from 'vitest'
import { createDetailHydration } from './detail-hydration'
import { createObservedReads } from './observed-reads'
import { ApiError } from '@/shared/api/internal'

afterEach(() => vi.useRealTimers())

it('rejects malformed and non-Error failures, keeps shared demand, and ignores observations after stopping', async () => {
  vi.useFakeTimers()
  const read = vi.fn().mockResolvedValueOnce(null).mockRejectedValueOnce('offline').mockResolvedValue({ value: 'ready' })
  const apply = vi.fn()
  const owner = createDetailHydration({ reads: createObservedReads(), read, apply, missing: vi.fn(), hasDetail: () => false, errorMessage: 'Invalid detail' })
  const first = owner.watch('item')
  const second = owner.watch('item')
  owner.start()
  await vi.advanceTimersByTimeAsync(0)
  expect(owner.snapshot('item')).toEqual({ status: 'error', error: 'Invalid detail' })
  first()
  await vi.advanceTimersByTimeAsync(2500)
  expect(owner.snapshot('item')).toEqual({ status: 'error', error: 'Invalid detail' })
  await vi.advanceTimersByTimeAsync(2500)
  expect(apply).toHaveBeenCalledWith('item', { value: 'ready' })
  owner.observe({ type: 'removed', id: 'item' })
  expect(owner.snapshot('item').status).toBe('missing')
  second(); second()
  owner.stop()
  owner.observe({ type: 'update', id: 'item' })
  expect(owner.snapshot('item').status).toBe('missing')
})

it('accepts preloaded details and a snapshot that restores observed records', async () => {
  const read = vi.fn().mockResolvedValue({ value: 'loaded' })
  const owner = createDetailHydration({ reads: createObservedReads(), read, apply: vi.fn(), missing: vi.fn(), hasDetail: (id) => id === 'cached', errorMessage: 'Invalid' })
  owner.start()
  const unwatch = owner.watch('cached')
  expect(owner.snapshot('cached').status).toBe('ready')
  owner.observe({ type: 'snapshot', ids: ['cached'], details: {} })
  await Promise.resolve()
  expect(read).toHaveBeenCalledWith('cached')
  owner.observe({ type: 'update', id: 'cached' })
  expect(owner.snapshot('cached').status).toBe('ready')
  owner.observe({ type: 'snapshot', ids: ['cached'], details: { cached: { value: 'pushed' } } })
  expect(owner.snapshot('cached').status).toBe('ready')
  unwatch(); owner.stop()
})

it('marks a demanded record missing on a current HTTP 404 and cancels recovery', async () => {
  vi.useFakeTimers()
  const missing = vi.fn()
  const read = vi.fn().mockRejectedValue(new ApiError(404, { error: 'deleted' }))
  const owner = createDetailHydration({ reads: createObservedReads(), read, apply: vi.fn(), missing, hasDetail: () => false, errorMessage: 'Invalid' })
  owner.start()
  const unwatch = owner.watch('deleted')
  await vi.advanceTimersByTimeAsync(0)
  expect(missing).toHaveBeenCalledWith('deleted')
  expect(owner.snapshot('deleted')).toEqual({ status: 'missing', error: null })
  await vi.advanceTimersByTimeAsync(5000)
  expect(read).toHaveBeenCalledTimes(1)
  unwatch(); owner.stop()
})

it.each(['stop', 'replacement'])('ignores a rejected read after %s supersedes it', async (mode) => {
  let reject!: (error: Error) => void
  const read = vi.fn().mockReturnValueOnce(new Promise((_, no) => { reject = no })).mockResolvedValue({ value: 'new' })
  const owner = createDetailHydration({ reads: createObservedReads(), read, apply: vi.fn(), missing: vi.fn(), hasDetail: () => false, errorMessage: 'Invalid' })
  owner.start()
  const pending = owner.load('item')
  if (mode === 'stop') owner.stop()
  else { owner.retry('item'); await Promise.resolve() }
  const current = owner.snapshot('item')
  reject(new Error('obsolete failure'))
  await pending
  expect(owner.snapshot('item')).toEqual(current)
  expect(owner.snapshot('item').error).toBeNull()
  owner.stop()
})
