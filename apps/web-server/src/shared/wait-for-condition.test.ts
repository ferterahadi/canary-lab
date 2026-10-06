import { afterEach, expect, it, vi } from 'vitest'
import { waitForCondition, type ConditionWaitOptions } from './wait-for-condition'

afterEach(() => vi.useRealTimers())

function harness() {
  vi.useFakeTimers()
  let value: string | null = null
  let notify = () => {}
  const unsubscribe = vi.fn()
  const options: ConditionWaitOptions<string> = {
    read: () => value, timeoutMs: 100, maxWaitMs: 200, onTimeout: () => 'timeout',
    subscribe: (callback) => { notify = callback; return unsubscribe },
  }
  return { options, unsubscribe, notify: () => notify(), set: (next: string) => { value = next } }
}

it('disposes a synchronous subscription before the promise settles', async () => {
  const h = harness()
  h.options.subscribe = (notify) => { h.set('ready'); notify(); return h.unsubscribe }
  await expect(waitForCondition(h.options)).resolves.toBe('ready')
  expect(h.unsubscribe).toHaveBeenCalledTimes(1)
  expect(vi.getTimerCount()).toBe(0)
})

it('coalesces notifications published by the condition reader without recursive reads', async () => {
  const h = harness()
  const pending = waitForCondition(h.options)
  let reads = 0
  h.options.read = () => {
    reads++
    if (reads === 1) { h.notify(); return null }
    return 'changed'
  }
  h.notify()
  await expect(pending).resolves.toBe('changed')
  expect(reads).toBe(2)
  expect(h.unsubscribe).toHaveBeenCalledTimes(1)
})

it.each(['before', 'read', 'subscribe', 'waiting'] as const)('returns cancellation when cancelled during %s', async (when) => {
  const h = harness()
  const controller = new AbortController()
  const remove = vi.spyOn(controller.signal, 'removeEventListener')
  h.options.cancellation = { signal: controller.signal, result: () => 'shutdown' }
  if (when === 'before') controller.abort()
  if (when === 'read') h.options.read = () => { controller.abort(); return null }
  if (when === 'subscribe') h.options.subscribe = () => { controller.abort(); return h.unsubscribe }
  const pending = waitForCondition(h.options)
  if (when === 'waiting') controller.abort()
  await expect(pending).resolves.toBe('shutdown')
  expect(h.unsubscribe).toHaveBeenCalledTimes(when === 'subscribe' || when === 'waiting' ? 1 : 0)
  if (when !== 'before') expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
  expect(vi.getTimerCount()).toBe(0)
})

it('cleans up when the cancellation result throws', async () => {
  const h = harness(); const controller = new AbortController()
  h.options.cancellation = { signal: controller.signal, result: () => { throw new Error('cancel failed') } }
  const pending = waitForCondition(h.options)
  const assertion = expect(pending).rejects.toThrow('cancel failed')
  controller.abort()
  await assertion
  expect(h.unsubscribe).toHaveBeenCalledTimes(1)
  expect(vi.getTimerCount()).toBe(0)
})

it('rejects cleanup failures after disposing timers and cancellation listeners', async () => {
  const h = harness(); const controller = new AbortController()
  const remove = vi.spyOn(controller.signal, 'removeEventListener')
  h.options.cancellation = { signal: controller.signal, result: () => 'shutdown' }
  h.unsubscribe.mockImplementation(() => { throw new Error('unsubscribe failed') })
  const pending = waitForCondition(h.options)
  const assertion = expect(pending).rejects.toThrow('unsubscribe failed')
  h.set('ready'); h.notify()
  await assertion
  expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
  expect(vi.getTimerCount()).toBe(0)
})

it('ignores a notification retained after cancellation', async () => {
  const h = harness(); const controller = new AbortController()
  h.options.cancellation = { signal: controller.signal, result: () => 'shutdown' }
  const pending = waitForCondition(h.options)
  controller.abort(); h.set('late'); h.notify()
  await expect(pending).resolves.toBe('shutdown')
  expect(h.unsubscribe).toHaveBeenCalledTimes(1)
})

it('settles only once when a reader cancels the wait before returning a value', async () => {
  const h = harness(); const controller = new AbortController()
  h.options.cancellation = { signal: controller.signal, result: () => 'shutdown' }
  const pending = waitForCondition(h.options)
  h.options.read = () => { controller.abort(); return 'too late' }
  h.notify()
  await expect(pending).resolves.toBe('shutdown')
  expect(h.unsubscribe).toHaveBeenCalledTimes(1)
})

it('rejects an initial reader error without subscribing', async () => {
  const h = harness()
  h.options.read = () => { throw new Error('read failed') }
  await expect(waitForCondition(h.options)).rejects.toThrow('read failed')
  expect(h.unsubscribe).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})
