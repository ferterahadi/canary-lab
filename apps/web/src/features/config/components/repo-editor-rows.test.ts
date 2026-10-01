import { expect, it } from 'vitest'
import { createRepoEditorRows } from './repo-editor-rows'
import type { RepoSlice } from './repo-slice'
const repo = (name: string): RepoSlice => ({ name, localPath: `/repos/${name}`, startCommands: [] })
it('follows edits and reorderings, expires removal/replacement/Discard, and never serializes identity', () => {
  const rows = createRepoEditorRows()
  let draft = [repo('a'), repo('b')]
  rows.identify(draft)
  const a = rows.id(draft[0])
  const b = rows.id(draft[1])
  draft = rows.update(draft, a, (latest) => ({ ...latest, name: 'edited' })).reverse()
  rows.identify(draft)
  expect(draft.map(rows.id)).toEqual([b, a])
  expect(JSON.parse(JSON.stringify(draft))).toEqual([repo('b'), { ...repo('a'), name: 'edited' }])
  const refreshed = structuredClone(draft)
  rows.identify(refreshed)
  expect(refreshed.map(rows.id)).toEqual([b, a])
  const removed = refreshed.filter((row) => rows.id(row) !== a)
  rows.identify(removed)
  expect(rows.update(removed, a, repo('obsolete'))).toEqual(removed)
  const replaced = [repo('replacement')]
  rows.identify(replaced)
  expect(rows.id(replaced[0])).not.toBe(b)
  rows.reset()
  rows.identify(refreshed)
  expect(refreshed.map(rows.id)).not.toContain(a)
  expect(rows.update(refreshed, a, repo('obsolete'))).toEqual(refreshed)
})
