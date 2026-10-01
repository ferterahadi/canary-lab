import { useEffect, useState } from 'react'

/** Selection follows authoritative eligibility without resetting valid choices
 * when an inventory is refreshed, temporarily unavailable, or reordered. */
export function useCleanupSelection<T>(rows: T[], idOf: (row: T) => string, eligible: (row: T) => boolean, confirmed: boolean) {
  const [ids, setIds] = useState<Set<string>>(new Set())
  const selectable = new Set(rows.filter(eligible).map(idOf))
  const selected = new Set([...ids].filter((id) => selectable.has(id)))
  useEffect(() => {
    if (!confirmed) return
    const allowed = new Set(rows.filter(eligible).map(idOf))
    setIds((previous) => {
      const next = new Set([...previous].filter((id) => allowed.has(id)))
      return next.size === previous.size ? previous : next
    })
  }, [rows, idOf, eligible, confirmed])
  return {
    selected,
    clear: () => setIds(new Set()),
    remove: (removed: string[]) => setIds((previous) => new Set([...previous].filter((id) => !removed.includes(id)))),
    toggle: (id: string) => {
      if (!selectable.has(id)) return
      setIds((previous) => {
        const next = new Set(previous)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        return next
      })
    },
    selectPreset: (predicate: (row: T) => boolean) => setIds(new Set(rows.filter((row) => eligible(row) && predicate(row)).map(idOf))),
  }
}
