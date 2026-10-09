import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { InvalidationProvider, useInvalidation } from '@/shared/state/invalidation'
import { ConfigDocCacheProvider } from './config-doc-cache'
import { useEditableSlice } from './useEditableSlice'
import { deferred } from '../../../../../../tools/test-helpers/deferred'
import { mountRoot } from '@/test-helpers/mount-root'

type Doc = { edited: string; untouched: string }
const load = vi.fn<() => Promise<Doc>>()
const save = vi.fn<(payload: unknown) => Promise<Doc>>()
let editor: ReturnType<typeof useEditableSlice<Doc, string>>
let invalidate: ReturnType<typeof useInvalidation>['invalidate']
let root: Root
function Harness({ name }: { name: string }) {
  invalidate = useInvalidation().invalidate
  editor = useEditableSlice({ cacheKey: `config:${name}`, load, save,
    extract: (doc: Doc) => doc.edited, merge: (doc, edited) => ({ ...doc, edited }) })
  return <output>{editor.draft}</output>
}
const render = (name = 'checkout') => root.render(<InvalidationProvider><ConfigDocCacheProvider><Harness name={name} /></ConfigDocCacheProvider></InvalidationProvider>)
const remote = async (edited: string, untouched = 'remote') => {
  load.mockResolvedValue({ edited, untouched })
  await act(async () => { invalidate('configuration', 'checkout') })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
  load.mockResolvedValue({ edited: 'initial', untouched: 'initial' })
})
afterEach(() => { vi.useRealTimers(); vi.resetAllMocks() })
mountRoot({ attach: true, onMount: (mounted) => ({ root } = mounted) })

it('updates clean forms and retains dirty drafts through unchanged reads and external edits', async () => {
  await act(async () => { render() })
  await remote('clean update')
  expect(editor.draft).toBe('clean update')
  expect(editor.dirty).toBe(false)
  await act(async () => { editor.setDraft((previous) => `${previous} + draft`) })
  await remote('clean update', 'unrelated update')
  expect(editor.draft).toBe('clean update + draft')
  expect(editor.error).toBeNull()
  await remote('external edit')
  expect(editor.draft).toBe('clean update + draft')
  expect(editor.baseline).toBe('clean update')
  expect(editor.error).toContain('Changed elsewhere')
  await act(async () => { editor.discard() })
  expect(editor.draft).toBe('external edit')
  expect(editor.dirty).toBe(false)
  expect(editor.error).toBeNull()
})

it('saves a preserved draft into the latest document without reverting unrelated external fields', async () => {
  await act(async () => { render() })
  await act(async () => { editor.setDraft('my draft') })
  await remote('their draft', 'latest unrelated field')
  save.mockImplementation(async (payload) => payload as Doc)
  await act(async () => { await editor.doSave() })
  expect(save).toHaveBeenCalledWith({ edited: 'my draft', untouched: 'latest unrelated field' })
  expect(editor.doc).toEqual({ edited: 'my draft', untouched: 'latest unrelated field' })
  expect(editor.dirty).toBe(false)
  expect(editor.error).toBeNull()
  expect(editor.savedAt).toBe(0)
})

it('preserves edits typed while saving and retains drafts across background failures and recovery', async () => {
  await act(async () => { render() })
  await act(async () => { editor.setDraft('submitted') })
  const pending = deferred<Doc>()
  save.mockReturnValue(pending.promise)
  let saving!: Promise<void>
  await act(async () => { saving = editor.doSave() })
  expect(editor.saving).toBe(true)
  await act(async () => { editor.setDraft('still typing') })
  await act(async () => { pending.resolve({ edited: 'submitted', untouched: 'initial' }); await saving })
  expect(editor.baseline).toBe('submitted')
  expect(editor.draft).toBe('still typing')
  expect(editor.dirty).toBe(true)
  load.mockRejectedValueOnce(new Error('offline'))
  await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
  expect(editor.error).toBe('offline')
  expect(editor.draft).toBe('still typing')
  await remote('submitted')
  expect(editor.error).toBeNull()
  expect(editor.draft).toBe('still typing')
})

it.each(['success', 'failure'])('ignores a late save %s after switching suites', async (result) => {
  await act(async () => { render() })
  await act(async () => { editor.setDraft('old suite draft') })
  const pending = deferred<Doc>()
  save.mockReturnValue(pending.promise)
  let saving!: Promise<void>
  await act(async () => { saving = editor.doSave() })
  load.mockResolvedValue({ edited: 'new suite', untouched: 'new' })
  await act(async () => { render('other') })
  expect(editor.draft).toBe('new suite')
  expect(editor.saving).toBe(false)
  await act(async () => {
    if (result === 'success') pending.resolve({ edited: 'old saved', untouched: 'old' })
    else pending.reject(new Error('old failure'))
    await saving
  })
  expect(editor.draft).toBe('new suite')
  expect(editor.doc?.untouched).toBe('new')
  expect(editor.error).toBeNull()
  expect(editor.savedAt).toBeNull()
})

it('ignores delayed reads for another suite and allows failed saves to be retried', async () => {
  const pending = deferred<Doc>()
  load.mockReturnValueOnce(pending.promise)
  await act(async () => { render() })
  expect(editor.loading).toBe(true)
  await act(async () => { await editor.doSave() })
  expect(save).not.toHaveBeenCalled()
  await act(async () => { render('other') })
  await act(async () => { pending.resolve({ edited: 'old', untouched: 'old' }) })
  expect(editor.draft).toBe('initial')
  await act(async () => { editor.setDraft('new draft') })
  save.mockRejectedValueOnce(new Error('save refused'))
  await act(async () => { await editor.doSave() })
  expect(editor.error).toBe('save refused')
  expect(editor.dirty).toBe(true)
  save.mockRejectedValueOnce('failed')
  await act(async () => { await editor.doSave() })
  expect(editor.error).toBe('Save failed')
  await act(async () => { editor.discard() })
  expect(editor.error).toBeNull()
  expect(editor.draft).toBe('initial')
})
