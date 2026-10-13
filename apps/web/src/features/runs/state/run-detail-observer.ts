interface ObservedRun {
  subscribers: number
  cadence: number
  timer?: ReturnType<typeof setTimeout>
}

/** One recovery reader per displayed run, independent of how many panes use it. */
export function createRunDetailObserver(deps: {
  exists(id: string): boolean
  active(id: string): boolean
  read(id: string): void
  invalidate(id: string): void
  hidden(): boolean
}) {
  const entries = new Map<string, ObservedRun>()
  const cadence = (id: string) => deps.active(id) ? 1000 : 15_000
  const schedule = (id: string, entry: ObservedRun) => {
    clearTimeout(entry.timer)
    entry.timer = undefined
    entry.cadence = cadence(id)
    if (deps.hidden() || !deps.exists(id)) return
    entry.timer = setTimeout(() => {
      // A hung read must not hold every subsequent recovery interval hostage.
      deps.read(id)
      schedule(id, entry)
    }, entry.cadence)
  }
  return {
    subscribe(id: string) {
      let entry = entries.get(id)
      if (!entry) {
        entry = { subscribers: 0, cadence: cadence(id) }
        entries.set(id, entry)
        if (!deps.hidden() && deps.exists(id)) deps.read(id)
        schedule(id, entry)
      }
      entry.subscribers++
      const current = entry
      return () => {
        if (--current.subscribers > 0) return
        clearTimeout(current.timer)
        entries.delete(id)
        deps.invalidate(id)
      }
    },
    sync() {
      for (const [id, entry] of entries) {
        if (!deps.exists(id)) {
          clearTimeout(entry.timer)
          entry.timer = undefined
          deps.invalidate(id)
        } else if (entry.timer === undefined || entry.cadence !== cadence(id)) schedule(id, entry)
      }
    },
    refresh() {
      for (const [id, entry] of entries) {
        deps.invalidate(id)
        if (!deps.hidden() && deps.exists(id)) deps.read(id)
        schedule(id, entry)
      }
    },
    close() {
      for (const [id, entry] of entries) {
        clearTimeout(entry.timer)
        deps.invalidate(id)
      }
      entries.clear()
    },
  }
}
