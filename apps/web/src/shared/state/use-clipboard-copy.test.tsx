import { act, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useClipboardCopy } from './use-clipboard-copy'

let root: Root
let state: ReturnType<typeof useClipboardCopy>
const clipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
function Probe({ duration }: { duration?: number | null }) { state = useClipboardCopy({ resetAfterMs: duration }); return null }
const render = (duration?: number | null) => act(async () => { root.render(<StrictMode><Probe duration={duration} /></StrictMode>) })
const write = (writeText: unknown) => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: writeText === undefined ? undefined : { writeText } })
beforeEach(() => { vi.useFakeTimers(); root = createRoot(document.createElement('div')) })
afterEach(() => {
  act(() => root.unmount())
  vi.useRealTimers()
  if (clipboard) Object.defineProperty(navigator, 'clipboard', clipboard)
  else Reflect.deleteProperty(navigator, 'clipboard')
})

it('waits for success and resets feedback after the latest copy duration', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined)
  write(writeText)
  await render()
  await act(async () => { expect(await state.copy('command', 'first')).toBe(true) })
  expect(writeText).toHaveBeenCalledWith('command')
  expect(state.copiedKey).toBe('first')
  act(() => vi.advanceTimersByTime(1000))
  await act(async () => { await state.copy('again') })
  act(() => vi.advanceTimersByTime(500))
  expect(state.copiedKey).toBe('again')
  act(() => vi.advanceTimersByTime(1000))
  expect(state.copiedKey).toBeNull()
})

it('handles unavailable and rejected clipboard writes without claiming success', async () => {
  await render()
  write(undefined)
  await act(async () => { expect(await state.copy('missing')).toBe(false) })
  write(vi.fn().mockRejectedValue(new Error('denied')))
  await act(async () => { expect(await state.copy('denied')).toBe(false) })
  expect(state.copiedKey).toBeNull()
  expect(vi.getTimerCount()).toBe(0)
})

it('supports custom timing and persistent feedback with explicit reset', async () => {
  write(vi.fn().mockResolvedValue(undefined))
  await render(1200)
  await act(async () => { await state.copy('token') })
  act(() => vi.advanceTimersByTime(1199))
  expect(state.copiedKey).toBe('token')
  act(() => vi.advanceTimersByTime(1))
  expect(state.copiedKey).toBeNull()
  await render(null)
  await act(async () => { await state.copy('path') })
  expect(vi.getTimerCount()).toBe(0)
  act(() => state.reset())
  expect(state.copiedKey).toBeNull()
})

it('ignores older completions and invalidates pending writes on reset or unmount', async () => {
  const completions: Array<() => void> = []
  write(() => new Promise<void>((resolve) => completions.push(resolve)))
  await render()
  let first: Promise<boolean>
  let second: Promise<boolean>
  act(() => { first = state.copy('first'); second = state.copy('second') })
  expect(state.copiedKey).toBeNull()
  await act(async () => { completions[1](); await second })
  await act(async () => { completions[0](); await first })
  expect(state.copiedKey).toBe('second')
  let resetPending: Promise<boolean>
  act(() => { resetPending = state.copy('reset'); state.reset() })
  await act(async () => { completions[2](); await resetPending })
  expect(state.copiedKey).toBeNull()
  let unmounted: Promise<boolean>
  act(() => { unmounted = state.copy('unmount'); root.render(null) })
  await act(async () => { completions[3](); await unmounted })
  expect(await state.copy('after unmount')).toBe(false)
  expect(vi.getTimerCount()).toBe(0)
})

it('clears a scheduled reset when unmounted', async () => {
  write(vi.fn().mockResolvedValue(undefined))
  await render()
  await act(async () => { await state.copy('value') })
  act(() => root.render(null))
  expect(vi.getTimerCount()).toBe(0)
})
