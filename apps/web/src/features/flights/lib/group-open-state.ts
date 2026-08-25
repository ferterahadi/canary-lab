// Persisted per-group disclosure open-state (R55). Shared by the flights
// picker (FlightsPill) and the features column (FeaturesColumn) so both group
// accordions remember which sections the user collapsed across refreshes and
// tabs. Each surface owns its own localStorage key; the group→bool map inside
// is the same shape. The resting default is per-surface (`defaultOpen`): the
// features column stays open, the flights picker collapses; either way an
// explicit user toggle is honoured over the default.

/** Read the per-group open map for a surface. A group the user has never
 *  toggled falls back to `defaultOpen` (default true); an explicit stored
 *  boolean always wins. Storage failures fall back to `defaultOpen`. */
export function readGroupOpen(storageKey: string, group: string, defaultOpen = true): boolean {
  try {
    const raw = localStorage.getItem(storageKey)
    if (!raw) return defaultOpen
    const map = JSON.parse(raw) as Record<string, boolean>
    return typeof map[group] === 'boolean' ? map[group] : defaultOpen
  } catch {
    return defaultOpen
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
