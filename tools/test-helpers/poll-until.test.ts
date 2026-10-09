import { afterEach, expect, it, vi } from 'vitest'
import { pollUntil } from './poll-until'

afterEach(() => vi.useRealTimers())

const message = (last: string): string => `stuck at ${last}`

it('returns an already accepted value without waiting', async () => {
  vi.useFakeTimers()
  await expect(pollUntil(async () => 'done', (v) => v === 'done', { timeoutMessage: message })).resolves.toBe('done')
  expect(vi.getTimerCount()).toBe(0)
})

it('reads again after the interval until the value is accepted', async () => {
  vi.useFakeTimers()
  let value = 'running'
  const read = vi.fn(async () => value)
  const pending = pollUntil(read, (v) => v === 'done', { intervalMs: 25, timeoutMessage: message })
  await vi.advanceTimersByTimeAsync(0)
  value = 'done'
  await vi.advanceTimersByTimeAsync(25)
  await expect(pending).resolves.toBe('done')
  expect(read).toHaveBeenCalledTimes(2)
})

it('throws the timeout message built from the last value read', async () => {
  vi.useFakeTimers()
  let value = 'running'
  const pending = pollUntil(async () => value, (v) => v === 'done', { timeoutMs: 40, timeoutMessage: message })
  const settled = expect(pending).rejects.toThrow('stuck at failed')
  await vi.advanceTimersByTimeAsync(30)
  value = 'failed'
  await vi.advanceTimersByTimeAsync(30)
  await settled
})

it('defaults to a 3000 ms deadline polled every 10 ms', async () => {
  vi.useFakeTimers()
  const read = vi.fn(async () => 'running')
  const pending = pollUntil(read, () => false, { timeoutMessage: message })
  const settled = expect(pending).rejects.toThrow('stuck at running')
  await vi.advanceTimersByTimeAsync(3000)
  expect(read).toHaveBeenCalledTimes(301)
  await vi.advanceTimersByTimeAsync(10)
  await settled
})
