import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RunStoreEvent } from '../features/runs/logic/run-store'
import { waitForRunCondition } from './wait-for-run-condition'

afterEach(() => { vi.useRealTimers() })

function harness() {
  vi.useFakeTimers()
  const listeners = new Set<(event: RunStoreEvent) => void>()
  const store = {
    onEvent: (fn: (event: RunStoreEvent) => void) => { listeners.add(fn) },
    offEvent: (fn: (event: RunStoreEvent) => void) => { listeners.delete(fn) },
  }
  let result: string | null = null
  const read = vi.fn(() => result)
  const options = { store, runId: 'run', read, timeoutMs: 20_000, maxWaitMs: 30_000, onTimeout: () => 'waiting' }
  return { listeners, options, read, set: (value: string) => { result = value },
    emit: (runId?: string) => { for (const fn of listeners) fn({ kind: 'changed', runId }) } }
}

describe('waitForRunCondition', () => {
  it('returns an existing outcome without subscribing or starting a heartbeat', async () => {
    const h = harness(); h.set('done')
    const beat = vi.fn()
    await expect(waitForRunCondition({ ...h.options, heartbeat: { beat, intervalMs: 5000 } })).resolves.toBe('done')
    expect(h.listeners.size).toBe(0)
    expect(beat).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('closes the read/subscribe gap and cleans up before returning', async () => {
    const h = harness()
    const subscribe = h.options.store.onEvent
    h.options.store.onEvent = (fn) => { subscribe(fn); h.set('done') }
    await expect(waitForRunCondition(h.options)).resolves.toBe('done')
    expect(h.listeners.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('handles a store that delivers its current event during subscription', async () => {
    const h = harness(); const beat = vi.fn()
    h.options.store.onEvent = (fn) => { h.listeners.add(fn); h.set('done'); h.emit() }
    await expect(waitForRunCondition({ ...h.options, heartbeat: { beat, intervalMs: 5000 } })).resolves.toBe('done')
    expect(beat).not.toHaveBeenCalled()
    expect(h.listeners.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([undefined, 'run'])('ignores other runs and wakes on a relevant event (%s)', async (id) => {
    const h = harness(); const pending = waitForRunCondition(h.options)
    const reads = h.read.mock.calls.length
    h.set('done'); h.emit('other')
    expect(h.read).toHaveBeenCalledTimes(reads)
    h.emit(id)
    await expect(pending).resolves.toBe('done')
    expect(h.listeners.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('beats immediately and every five seconds, then clears both timers on settlement', async () => {
    const h = harness(); const beat = vi.fn()
    const pending = waitForRunCondition({ ...h.options, heartbeat: { beat, intervalMs: 5000 } })
    expect(beat).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(beat).toHaveBeenCalledTimes(3)
    h.set('done'); h.emit()
    await expect(pending).resolves.toBe('done')
    await vi.advanceTimersByTimeAsync(30_000)
    expect(beat).toHaveBeenCalledTimes(3)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([[-10, 1], [100_000, 30_000]])('clamps a requested %s ms wait to %s ms', async (timeoutMs, elapsed) => {
    const h = harness(); const timeout = vi.fn(() => 'waiting')
    const pending = waitForRunCondition({ ...h.options, timeoutMs, onTimeout: timeout })
    await vi.advanceTimersByTimeAsync(elapsed - 1)
    expect(timeout).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await expect(pending).resolves.toBe('waiting')
    expect(h.listeners.size).toBe(0)
  })

  it('settles once when a retained event callback races the timeout', async () => {
    const h = harness(); const pending = waitForRunCondition(h.options)
    const callback = [...h.listeners][0]
    await vi.advanceTimersByTimeAsync(20_000)
    h.set('late'); const reads = h.read.mock.calls.length
    callback({ kind: 'changed', runId: 'run' })
    await expect(pending).resolves.toBe('waiting')
    expect(h.read).toHaveBeenCalledTimes(reads)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['read', 'timeout', 'heartbeat', 'initial-heartbeat', 'subscribe'] as const)('rejects and cleans up after a %s error', async (source) => {
    const h = harness(); const error = new Error('failure')
    const fail = () => { throw error }
    let beats = 0
    if (source === 'subscribe') h.options.store.onEvent = (fn) => { h.listeners.add(fn); fail() }
    const pending = waitForRunCondition({ ...h.options,
      onTimeout: source === 'timeout' ? fail : h.options.onTimeout,
      heartbeat: { intervalMs: 5000, beat: () => {
        if (source === 'initial-heartbeat' || (source === 'heartbeat' && beats++ > 0)) fail()
      } },
    })
    const assertion = expect(pending).rejects.toThrow(error)
    if (source === 'read') { h.read.mockImplementation(fail); h.emit() }
    if (source === 'timeout') await vi.advanceTimersByTimeAsync(20_000)
    if (source === 'heartbeat') await vi.advanceTimersByTimeAsync(5000)
    await assertion
    expect(h.listeners.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })
})
