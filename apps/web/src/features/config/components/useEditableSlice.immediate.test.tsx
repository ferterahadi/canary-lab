import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { InvalidationProvider, useInvalidation } from '@/shared/state/invalidation'
import { useEditableSlice } from './useEditableSlice'

type Doc = { workers: number; retries: number; external: string }
const initial: Doc = { workers: 1, retries: 0, external: 'initial' }
const load = vi.fn<() => Promise<Doc>>()
const save = vi.fn<(value: unknown) => Promise<Doc>>()
let editor: ReturnType<typeof useEditableSlice<Doc, Doc>>
let invalidate: ReturnType<typeof useInvalidation>['invalidate']
let root: Root
let container: HTMLDivElement
function Harness({ name }: { name: string }) {
  invalidate = useInvalidation().invalidate
  editor = useEditableSlice({ cacheKey: `config:${name}`, load, save, extract: (doc: Doc) => doc, merge: (_doc, value) => value, immediate: true })
  return null
}
const render = (name = 'checkout') => root.render(<InvalidationProvider><Harness name={name} /></InvalidationProvider>)
function deferred() {
  let resolve!: (doc: Doc) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<Doc>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
beforeEach(() => {
  vi.useFakeTimers(); load.mockResolvedValue(initial); save.mockImplementation(async (value) => value as Doc)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); container.remove(); vi.useRealTimers(); vi.resetAllMocks() })
const edit = async (patch: Partial<Doc>) => act(async () => { editor.editImmediate((value) => ({ ...value, ...patch })) })

it('serializes rapid field edits against the accepted response and retains edits during saves', async () => {
  await act(async () => render())
  const pending = deferred(); save.mockReturnValueOnce(pending.promise)
  await edit({ workers: 2 }); await edit({ retries: 3 }); await edit({ workers: 4 })
  expect(save).toHaveBeenCalledTimes(1)
  expect(editor.doc).toEqual(initial)
  expect(editor.draft).toEqual({ ...initial, workers: 4, retries: 3 })
  await act(async () => pending.resolve({ ...initial, workers: 2, external: 'server enriched' }))
  expect(save).toHaveBeenNthCalledWith(2, { workers: 4, retries: 3, external: 'server enriched' })
  expect(editor.dirty).toBe(false)
  expect(editor.doc).toEqual({ workers: 4, retries: 3, external: 'server enriched' })
})

it('retains failed edits, pauses subsequent writes, and retries on the latest external base', async () => {
  await act(async () => render())
  save.mockRejectedValueOnce(new Error('disk unavailable'))
  await edit({ workers: 2 }); await edit({ retries: 5 })
  load.mockResolvedValue({ ...initial, external: 'external update' })
  await act(async () => { invalidate('configuration', 'checkout'); await vi.advanceTimersByTimeAsync(5000) })
  expect(save).toHaveBeenCalledTimes(1)
  expect(editor.error).toBe('disk unavailable')
  expect(editor.draft).toEqual({ workers: 2, retries: 5, external: 'external update' })
  await act(async () => editor.doSave())
  expect(save).toHaveBeenLastCalledWith({ workers: 2, retries: 5, external: 'external update' })
  expect(editor.error).toBeNull(); expect(editor.dirty).toBe(false)
})

it('publishes save responses so delayed document reads cannot undo them', async () => {
  await act(async () => render())
  const old = deferred(); load.mockReturnValueOnce(old.promise)
  await act(async () => invalidate('configuration', 'checkout'))
  await edit({ workers: 7 })
  await act(async () => old.resolve(initial))
  expect(editor.doc?.workers).toBe(7)
})

it.each(['replacement', 'teardown'])('rejects late saves and queued work after %s', async (mode) => {
  await act(async () => render())
  const pending = deferred(); save.mockReturnValueOnce(pending.promise)
  await edit({ workers: 2 }); await edit({ retries: 3 })
  const captured = editor.editImmediate
  await act(async () => { if (mode === 'replacement') render('other'); else root.render(null) })
  await act(async () => { pending.resolve({ ...initial, workers: 2 }); captured((value) => ({ ...value, workers: 9 })) })
  expect(save).toHaveBeenCalledTimes(1)
  if (mode === 'replacement') expect(editor.doc).toEqual(initial)
})
