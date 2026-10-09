// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useLiveResource, type LiveResource } from './use-live-resource'

let root: Root
let live: LiveResource<string[]>
let replies: Array<(value: string[]) => void>
const fetcher = vi.fn(() => new Promise<string[]>((resolve) => replies.push(resolve)))
function Probe({ id, cache }: { id: string | null; cache?: string }) {
  live = useLiveResource(null, id, fetcher, { reconcileMs: 10_000, cache })
  return null
}
beforeEach(() => {
  vi.useFakeTimers()
  replies = []
  fetcher.mockClear()
  root = createRoot(document.createElement('div'))
})
afterEach(() => { act(() => root.unmount()); vi.useRealTimers() })
it('accepts a mutation across refreshes and supersedes every pending read', async () => {
  await act(async () => root.render(<Probe id="a" />))
  const accept = live.accept
  await act(async () => live.refresh())
  await act(async () => { expect(accept(['new'])).toBe(true) })
  await act(async () => { replies[1](['old']); replies[0](['older']) })
  expect(live.value).toEqual(['new'])
  expect(live.loading).toBe(false)
  expect(live.confirmed).toBe(true)
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
  await act(async () => replies[2](['next']))
  expect(live.value).toEqual(['next'])
})
it('applies an updater to the latest accepted list and retains it in the remount cache', async () => {
  await act(async () => root.render(<Probe id="cache" cache="observations-test" />))
  await act(async () => replies[0](['delete', 'new']))
  const accept = live.accept
  await act(async () => live.refresh())
  await act(async () => replies[1](['delete', 'new', 'newest']))
  await act(async () => accept((current) => current!.filter((item) => item !== 'delete')))
  expect(live.value).toEqual(['new', 'newest'])
  await act(async () => root.render(<Probe id={null} cache="observations-test" />))
  await act(async () => root.render(<Probe id="cache" cache="observations-test" />))
  expect(live.value).toEqual(['new', 'newest'])
})
it('rejects old callbacks after A to B to A replacement, null identity, and teardown', async () => {
  await act(async () => root.render(<Probe id="a" />))
  const old = live.accept
  await act(async () => root.render(<Probe id="b" />))
  expect(old(['wrong'])).toBe(false)
  await act(async () => root.render(<Probe id="a" />))
  expect(old(['wrong'])).toBe(false)
  await act(async () => root.render(<Probe id={null} />))
  expect(live.accept(['wrong'])).toBe(false)
  await act(async () => root.render(<Probe id="a" />))
  const current = live.accept
  await act(async () => root.render(null))
  expect(current(['wrong'])).toBe(false)
  await act(async () => replies.forEach((reply) => reply(['late'])))
})

it('opt-in manual retention keeps accepted values through refresh/failure without periodic reads or identity leaks', async () => {
  const reader = vi.fn<(id: string) => Promise<string[]>>().mockResolvedValue(['accepted'])
  function Manual({ id }: { id: string }) { live = useLiveResource(null, id, reader, { retainOnError: true }); return null }
  await act(async () => root.render(<Manual id="one" />))
  reader.mockRejectedValueOnce(new Error('offline'))
  await act(async () => live.refresh())
  expect(live.value).toEqual(['accepted'])
  expect(live.error).toBe('offline')
  await act(async () => { await vi.advanceTimersByTimeAsync(60000) })
  expect(reader).toHaveBeenCalledTimes(2)
  reader.mockReturnValue(new Promise(() => {}))
  await act(async () => root.render(<Manual id="two" />))
  expect(live.value).toBeNull()
  expect(live.error).toBeNull()
})
