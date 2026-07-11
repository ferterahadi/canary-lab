// Persisted per-group disclosure open-state (R55). Shared by the flights
// picker (FlightsPill) and the features column (FeaturesColumn) so both group
// accordions remember which sections the user collapsed across refreshes and
// tabs. Each surface owns its own localStorage key; the group→bool map inside
// is the same shape. Default OPEN — a group only stays collapsed once the user
// deliberately closes it.

/** Read the per-group open map for a surface; a group defaults to OPEN unless
 *  it was explicitly closed (stored `false`). Storage failures fall back open. */
export function readGroupOpen(storageKey: string, group: string): boolean {
  try {
    const raw = localStorage.getItem(storageKey)
    if (!raw) return true
    const map = JSON.parse(raw) as Record<string, boolean>
    return map[group] !== false
  } catch {
    return true
  }
}

/** Persist a single group's open-state under the surface's key (merged into the
 *  existing map). Non-fatal when storage is unavailable. */
export function writeGroupOpen(storageKey: string, group: string, open: boolean): void {
  try {
    const raw = localStorage.getItem(storageKey)
    const map = raw ? (JSON.parse(raw) as Record<string, boolean>) : {}
    map[group] = open
    localStorage.setItem(storageKey, JSON.stringify(map))
  } catch {
    /* storage unavailable — non-fatal */
  }
}
