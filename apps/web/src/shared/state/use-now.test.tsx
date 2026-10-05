import { act, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useNow } from './use-now'

let root: Root
let now: number
function Probe({ options }: { options?: Parameters<typeof useNow>[0] }) { now = useNow(options); return null }
const render = (options?: Parameters<typeof useNow>[0]) => act(async () => { root.render(<StrictMode><Probe options={options} /></StrictMode>) })
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); root = createRoot(document.createElement('div')) })
afterEach(() => { act(() => root.unmount()); vi.useRealTimers() })

it('ticks each second, keeps one interval across renders, and cleans up on unmount', async () => {
  await render()
  expect(now).toBe(0)
  expect(vi.getTimerCount()).toBe(1)
  act(() => vi.advanceTimersByTime(1000))
  expect(now).toBe(1000)
  await render()
  expect(vi.getTimerCount()).toBe(1)
  act(() => root.render(null))
  expect(vi.getTimerCount()).toBe(0)
})

it('supports slower clocks, stops while disabled, and optionally refreshes at a reset', async () => {
  await render({ intervalMs: 30_000 })
  act(() => vi.advanceTimersByTime(29_999))
  expect(now).toBe(0)
  act(() => vi.advanceTimersByTime(1))
  expect(now).toBe(30_000)
  await render({ enabled: false })
  expect(vi.getTimerCount()).toBe(0)
  act(() => vi.advanceTimersByTime(1000))
  expect(now).toBe(30_000)
  await render({ enabled: false, resetKey: 'updated', refreshOnReset: true })
  expect(now).toBe(31_000)
  await render({ resetKey: 'new job', refreshOnReset: true })
  expect(vi.getTimerCount()).toBe(1)
  act(() => vi.advanceTimersByTime(1000))
  expect(now).toBe(32_000)
})

it('restarts the interval when the identity changes without an unwanted immediate tick', async () => {
  await render({ resetKey: 'first' })
  act(() => vi.advanceTimersByTime(500))
  await render({ resetKey: 'second' })
  expect(now).toBe(0)
  act(() => vi.advanceTimersByTime(500))
  expect(now).toBe(0)
  act(() => vi.advanceTimersByTime(500))
  expect(now).toBe(1500)
})
