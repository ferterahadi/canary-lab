// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { useEditableDraft } from './use-editable-draft'
type Doc = { editor: string; enabled: boolean; path: string | null }
const original: Doc = { editor: 'auto', enabled: false, path: '/synthetic/wiki' }
let root: Root
let state: ReturnType<typeof useEditableDraft<Doc, Doc>>
function Probe({ doc, id = 'settings' }: { doc: Doc; id?: string }) { state = useEditableDraft({ key: id, doc, extract: (v) => v, fields: true }); return null }
const render = (doc = original, id?: string) => act(async () => { root.render(<Probe doc={doc} id={id} />) })
beforeEach(() => { root = createRoot(document.createElement('div')) })
afterEach(() => act(() => root.unmount()))
it('preserves newer edits including reverts, without converting remote refreshes into drafts', async () => {
  await render()
  await act(async () => { state.setDraft({ ...original, editor: 'cursor' }) })
  const submitted = state.draft!
  const accept = state.acceptSaved
  await render({ ...original, enabled: true })
  await act(async () => { state.setDraft((v) => ({ ...v, editor: 'auto' })) })
  const saved = { ...original, editor: 'cursor' }
  await act(async () => { expect(accept(saved, submitted)).toBe(false); root.render(<Probe doc={saved} />) })
  expect(state.draft).toEqual(original)
  expect(state.patch).toEqual({ editor: 'auto' })
  // The next owning-resource render carries that same accepted server object.
  await render(saved)
  expect(state.patch).toEqual({ editor: 'auto' })
})
it('keeps explicit clearing and rejects a save belonging to a replaced identity', async () => {
  await render()
  await act(async () => { state.setDraft((v) => ({ ...v, path: null })) })
  expect(state.patch).toEqual({ path: null })
  const accept = state.acceptSaved
  const submitted = state.draft!
  await render(original, 'replacement')
  expect(accept({ ...original, path: null }, submitted)).toBe(false)
  expect(state.draft).toEqual(original)
})
