// R12: durable workspace view selection. The open top-level view + selected
// feature must survive a page refresh AND be consistent across browser tabs —
// they can't live only in React state. The URL is the source of truth (so a
// refresh and a newly-opened tab both rehydrate from it); localStorage mirrors
// it so we can broadcast changes to other already-open tabs via `storage` events.

export type WorkspaceView = 'workspace' | 'cleanup' | 'coverage'

export interface PersistedView {
  view: WorkspaceView
  feature: string | null
}

const STORAGE_KEY = 'cl.workspace.view'
const VIEWS: WorkspaceView[] = ['workspace', 'cleanup', 'coverage']

function isView(v: string | null): v is WorkspaceView {
  return v != null && (VIEWS as string[]).includes(v)
}

/** Read the persisted view, URL first (authoritative on load), then localStorage. */
export function readPersistedView(): PersistedView {
  // URL wins — it's what a refresh or a copy-pasted/new tab carries.
  try {
    const params = new URLSearchParams(window.location.search)
    const v = params.get('view')
    if (isView(v)) return { view: v, feature: params.get('feature') || null }
  } catch { /* ignore */ }
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<PersistedView>
      if (isView(parsed.view ?? null)) {
        return { view: parsed.view as WorkspaceView, feature: parsed.feature ?? null }
      }
    }
  } catch { /* ignore */ }
  return { view: 'workspace', feature: null }
}

/** Persist to BOTH the URL (replaceState — no history spam) and localStorage
 *  (which fires a `storage` event in other tabs for live cross-tab sync). */
export function persistView(state: PersistedView): void {
  try {
    const params = new URLSearchParams(window.location.search)
    if (state.view === 'workspace') params.delete('view')
    else params.set('view', state.view)
    if (state.feature) params.set('feature', state.feature)
    else params.delete('feature')
    const qs = params.toString()
    const url = `${window.location.pathname}${qs ? `?${qs}` : ''}${window.location.hash}`
    window.history.replaceState(null, '', url)
  } catch { /* ignore */ }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch { /* ignore */ }
}

/** Subscribe to cross-tab view changes. Returns an unsubscribe fn. */
export function onViewChangedInOtherTab(cb: (state: PersistedView) => void): () => void {
  const handler = (e: StorageEvent) => {
    if (e.key !== STORAGE_KEY || e.newValue == null) return
    try {
      const parsed = JSON.parse(e.newValue) as Partial<PersistedView>
      if (isView(parsed.view ?? null)) cb({ view: parsed.view as WorkspaceView, feature: parsed.feature ?? null })
    } catch { /* ignore */ }
  }
  window.addEventListener('storage', handler)
  return () => window.removeEventListener('storage', handler)
}
