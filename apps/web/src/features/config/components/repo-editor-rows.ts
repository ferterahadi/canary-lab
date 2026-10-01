import type { RepoSlice } from './repo-slice'

export type RepoEdit = RepoSlice | ((current: RepoSlice) => RepoSlice)

/** Row identity is editor metadata, never configuration. Equal refreshes keep
 * mounted controls; replacement and Discard expire their asynchronous work. */
export function createRepoEditorRows() {
  let ids = new WeakMap<RepoSlice, number>()
  let previous: RepoSlice[] = []
  let sequence = 0
  const id = (repo: RepoSlice): number => {
    let value = ids.get(repo)
    if (value === undefined) { value = ++sequence; ids.set(repo, value) }
    return value
  }
  return {
    identify(repos: RepoSlice[]) {
      const claimed = new Set(repos.flatMap((repo) => ids.has(repo) ? [id(repo)] : []))
      for (const repo of repos) {
        if (ids.has(repo)) continue
        const same = previous.find((old) => !claimed.has(id(old)) && JSON.stringify(old) === JSON.stringify(repo))
        if (same) ids.set(repo, id(same))
        claimed.add(id(repo))
      }
      previous = repos
    },
    id,
    update(repos: RepoSlice[], rowId: number, edit: RepoEdit) {
      return repos.map((repo) => {
        if (id(repo) !== rowId) return repo
        const next = typeof edit === 'function' ? edit(repo) : edit
        ids.set(next, rowId)
        return next
      })
    },
    reset() { ids = new WeakMap(); previous = [] },
  }
}
