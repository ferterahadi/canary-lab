import { afterEach, expect, it, vi } from 'vitest'
import { waitForStatus } from './wait-for-status'

afterEach(() => vi.useRealTimers())

it('returns an already reached status without waiting', async () => {
  vi.useFakeTimers()
  await expect(waitForStatus({ get: () => ({ status: 'done' }) }, 'id', ['done'])).resolves.toBe('done')
  expect(vi.getTimerCount()).toBe(0)
})

it.each([20, 25])('observes a later status after the %i ms interval', async (intervalMs) => {
  vi.useFakeTimers()
  let status = 'running'
  const pending = waitForStatus({ get: () => ({ status }) }, 'id', ['done'], 8000, intervalMs)
  status = 'done'
  await vi.advanceTimersByTimeAsync(intervalMs)
  await expect(pending).resolves.toBe('done')
  expect(vi.getTimerCount()).toBe(0)
})

it('returns the final status when the deadline is reached', async () => {
  vi.useFakeTimers()
  let status = 'running'
  const pending = waitForStatus({ get: () => ({ status }) }, 'id', ['done'])
  await vi.advanceTimersByTimeAsync(7980)
  status = 'failed'
  await vi.advanceTimersByTimeAsync(20)
  await expect(pending).resolves.toBe('failed')
})

it('returns missing when no record exists at timeout', async () => {
  vi.useFakeTimers()
  const pending = waitForStatus({ get: () => null }, 'id', ['done'], 40)
  await vi.advanceTimersByTimeAsync(40)
  await expect(pending).resolves.toBe('missing')
})
