import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCappedDebounce } from './debounced-watch'

beforeEach(() => { vi.useFakeTimers({ now: 0 }) })
afterEach(() => { vi.useRealTimers() })

describe('createCappedDebounce', () => {
  it('flushes once after a 250ms quiet window', () => {
    const flush = vi.fn()
    const debounce = createCappedDebounce(flush)

    debounce.schedule()
    vi.advanceTimersByTime(200)
    debounce.schedule()
    vi.advanceTimersByTime(249)
    expect(flush).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(flush).toHaveBeenCalledTimes(1)
  })

  it('still flushes within 1s of the first change under a steady stream', () => {
    const flush = vi.fn()
    const debounce = createCappedDebounce(flush)

    for (let elapsed = 0; elapsed < 1000; elapsed += 100) {
      debounce.schedule()
      vi.advanceTimersByTime(100)
    }

    expect(flush).toHaveBeenCalledTimes(1)
    expect(Date.now()).toBe(1000)
  })

  it('starts a fresh burst after a flush', () => {
    const flush = vi.fn()
    const debounce = createCappedDebounce(flush)

    debounce.schedule()
    vi.advanceTimersByTime(900)
    debounce.schedule()
    vi.advanceTimersByTime(100)
    expect(flush).toHaveBeenCalledTimes(1)

    // A capped burst would flush immediately; a fresh one waits a full window.
    debounce.schedule()
    vi.advanceTimersByTime(249)
    expect(flush).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1)
    expect(flush).toHaveBeenCalledTimes(2)
  })

  it('drops a scheduled flush on cancel', () => {
    const flush = vi.fn()
    const debounce = createCappedDebounce(flush)

    debounce.schedule()
    debounce.cancel()
    vi.advanceTimersByTime(5000)

    expect(flush).not.toHaveBeenCalled()
  })
})
