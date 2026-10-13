import { afterEach, expect, it, vi } from 'vitest'
import { sleep } from './sleep'

afterEach(() => { vi.useRealTimers() })

it('resolves only after the delay has elapsed', async () => {
  vi.useFakeTimers()
  let settled = false
  const done = sleep(50).then(() => { settled = true })
  await vi.advanceTimersByTimeAsync(49)
  expect(settled).toBe(false)
  await vi.advanceTimersByTimeAsync(1)
  await done
  expect(settled).toBe(true)
})
