import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useElapsed } from './use-elapsed'

let root: Root
let elapsed: string | null
function Probe({ iso }: { iso: string | undefined }) { elapsed = useElapsed(iso); return null }
const render = (iso: string | undefined) => act(async () => { root.render(<Probe iso={iso} />) })
const at = (ms: number): string => new Date(ms).toISOString()
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(100_000); root = createRoot(document.createElement('div')) })
afterEach(() => { act(() => root.unmount()); vi.useRealTimers() })

it('ticks a live clock from the stamp and rolls over past a minute', async () => {
  await render(at(100_000 - 58_000))
  expect(elapsed).toBe('58s')
  act(() => vi.advanceTimersByTime(1000))
  expect(elapsed).toBe('59s')
  act(() => vi.advanceTimersByTime(15_000))
  expect(elapsed).toBe('1m 14s')
})

it('is null and stops ticking with no stamp or an unparseable one', async () => {
  await render(undefined)
  expect(elapsed).toBeNull()
  expect(vi.getTimerCount()).toBe(0)
  await render('not a date')
  expect(elapsed).toBeNull()
  expect(vi.getTimerCount()).toBe(0)
})

it('restarts from the current time when the stamp changes', async () => {
  await render(at(100_000))
  act(() => vi.advanceTimersByTime(5000))
  expect(elapsed).toBe('5s')
  await render(at(105_000 - 2000))
  expect(elapsed).toBe('2s')
})

it('shows nothing when the producer clock disagrees with the browser', async () => {
  await render(at(100_000 + 5000))
  expect(elapsed).toBeNull()
  await render(at(100_000 - 86_400_001))
  expect(elapsed).toBeNull()
})
