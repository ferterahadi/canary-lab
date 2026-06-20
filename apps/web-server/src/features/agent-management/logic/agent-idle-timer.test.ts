import { afterEach, describe, expect, it, vi } from 'vitest'
import { startIdleTimer } from './agent-idle-timer'

afterEach(() => {
  vi.useRealTimers()
})

describe('startIdleTimer', () => {
  it('trips onIdle only after the full window passes with no bump', () => {
    vi.useFakeTimers()
    let clock = 0
    const onIdle = vi.fn()
    const timer = startIdleTimer({ idleMs: 30, pollMs: 10, now: () => clock, onIdle })

    clock = 10
    vi.advanceTimersByTime(10)
    expect(onIdle).not.toHaveBeenCalled()

    clock = 35
    vi.advanceTimersByTime(10)
    expect(onIdle).toHaveBeenCalledTimes(1)
    expect(onIdle).toHaveBeenCalledWith(35)
    timer.stop()
  })

  it('bump() resets the clock so a steady stream never trips', () => {
    vi.useFakeTimers()
    let clock = 0
    const onIdle = vi.fn()
    const timer = startIdleTimer({ idleMs: 30, pollMs: 10, now: () => clock, onIdle })

    for (let i = 0; i < 10; i++) {
      clock += 10
      timer.bump() // output arrived just before each poll
      vi.advanceTimersByTime(10)
    }
    expect(onIdle).not.toHaveBeenCalled()
    timer.stop()
  })

  it('fires onIdle at most once and onTick while still active', () => {
    vi.useFakeTimers()
    let clock = 0
    const onIdle = vi.fn()
    const onTick = vi.fn()
    const timer = startIdleTimer({ idleMs: 25, pollMs: 10, now: () => clock, onIdle, onTick })

    clock = 10
    vi.advanceTimersByTime(10) // idle 10 < 25 → tick
    clock = 20
    vi.advanceTimersByTime(10) // idle 20 < 25 → tick
    clock = 40
    vi.advanceTimersByTime(10) // idle 40 ≥ 25 → idle
    clock = 80
    vi.advanceTimersByTime(10) // already fired → no-op

    expect(onIdle).toHaveBeenCalledTimes(1)
    expect(onTick).toHaveBeenCalledTimes(2)
    expect(onTick).toHaveBeenNthCalledWith(1, 10)
    expect(onTick).toHaveBeenNthCalledWith(2, 20)
    timer.stop()
  })

  it('growth in the activity counter resets the clock (JSONL-growth signal)', () => {
    vi.useFakeTimers()
    let clock = 0
    let jsonlSize = 0
    const onIdle = vi.fn()
    const timer = startIdleTimer({ idleMs: 30, pollMs: 10, now: () => clock, activity: () => jsonlSize, onIdle })

    // Agent keeps writing tool events to the JSONL — never trips despite no bump().
    for (let i = 0; i < 8; i++) {
      clock += 10
      jsonlSize += 100
      vi.advanceTimersByTime(10)
    }
    expect(onIdle).not.toHaveBeenCalled()

    // Writing stops — now the clock runs out.
    clock += 35
    vi.advanceTimersByTime(10)
    expect(onIdle).toHaveBeenCalledTimes(1)
    timer.stop()
  })

  it('stop() halts further checks', () => {
    vi.useFakeTimers()
    let clock = 0
    const onIdle = vi.fn()
    const timer = startIdleTimer({ idleMs: 30, pollMs: 10, now: () => clock, onIdle })
    timer.stop()
    clock = 100
    vi.advanceTimersByTime(50)
    expect(onIdle).not.toHaveBeenCalled()
  })
})
