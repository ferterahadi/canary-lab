// R12: durable workspace view selection. The open top-level view + selected
// feature must survive a page refresh AND be consistent across browser tabs —
// they can't live only in React state. The URL is the source of truth (so a
// refresh and a newly-opened tab both rehydrate from it); localStorage mirrors
// it so we can broadcast changes to other already-open tabs via `storage` events.
//
// R24: the URL also carries the *selected run* and the *open routed dialog* so a
// deep-linked / refreshed / bookmarked URL reopens the exact place you were. Two
// tiers, deliberately:
//   - Durable nav (view + feature): URL + localStorage + cross-tab `storage`.
//   - Run + dialog: URL only. A run selection isn't mirrored cross-tab (two tabs
//     may sit on different runs to compare them), and a dialog open in one tab
//     must NOT pop open in another — so neither goes to localStorage.

export type WorkspaceView = 'workspace' | 'cleanup' | 'coverage' | 'flights'

// Routed dialogs — only those that are coherent on a cold load (fresh tab, no
// prior in-memory state). Transient dialogs (collision confirm, services/runs
// pickers) are deliberately NOT routed. `verification` is feature-scoped and
// lives in the workspace runs column. `evaluation` is the export-progress dialog
// (status-bar toast) — its task record persists server-side, so a deep link
// re-opens it.
export type RouteDialog = 'config' | 'portify' | 'add-test' | 'verification' | 'evaluation'

export interface PersistedView {
  view: WorkspaceView
  feature: string | null
  /** Selected run id (URL only). */
  run: string | null
  /** Open routed dialog, if any (URL only). */
  dialog: RouteDialog | null
  /** Workflow id qualifier for `dialog: 'portify'` — present = revisit, absent = start-new. */
  wf: string | null
  /** Task id qualifier for `dialog: 'evaluation'` — which export task to re-open. */
  task: string | null
  /** Flight id qualifier for `view: 'flights'` — which flight detail to open
   *  (URL only; absent = the flights landing list). */
  flight: string | null
}

/** The cross-tab/localStorage-mirrored subset — the durable nav tier only. */
export type DurableView = Pick<PersistedView, 'view' | 'feature'>

const STORAGE_KEY = 'cl.workspace.view'
const VIEWS: WorkspaceView[] = ['workspace', 'cleanup', 'coverage', 'flights']
const DIALOGS: RouteDialog[] = ['config', 'portify', 'add-test', 'verification', 'evaluation']

function isView(v: string | null): v is WorkspaceView {
  return v != null && (VIEWS as string[]).includes(v)
}

function parseDialog(v: string | null): RouteDialog | null {
  return v != null && (DIALOGS as string[]).includes(v) ? (v as RouteDialog) : null
}

function setOrDelete(params: URLSearchParams, key: string, value: string | null): void {
  if (value) params.set(key, value)
  else params.delete(key)
}

const EMPTY: PersistedView = { view: 'workspace', feature: null, run: null, dialog: null, wf: null, task: null, flight: null }

/** Read the persisted view, URL first (authoritative on load), then localStorage
 *  (durable tier only — run/dialog/wf are never mirrored there). */
export function readPersistedView(): PersistedView {
  // URL wins — it's what a refresh, a copy-pasted/new tab, or a deep link carries.
  try {
    const params = new URLSearchParams(window.location.search)
    const v = params.get('view')
    const feature = params.get('feature') || null
    const run = params.get('run') || null
    const dialog = parseDialog(params.get('dialog'))
    const wf = dialog === 'portify' ? params.get('wf') || null : null
    const task = dialog === 'evaluation' ? params.get('task') || null : null
    // `flight` only qualifies the flights view — dropped elsewhere.
    const flight = v === 'flights' ? params.get('flight') || null : null
    // A bare `view` (workspace) is omitted from the URL, so treat any other
    // routed param as evidence the URL is authoritative for this load too.
    if (isView(v)) return { view: v, feature, run, dialog, wf, task, flight }
    if (feature || run || dialog) return { view: 'workspace', feature, run, dialog, wf, task, flight: null }
  } catch { /* ignore */ }
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<PersistedView>
      if (isView(parsed.view ?? null)) {
        return { ...EMPTY, view: parsed.view as WorkspaceView, feature: parsed.feature ?? null }
      }
    }
  } catch { /* ignore */ }
  return { ...EMPTY }
}

/** Persist to the URL (replaceState — no history spam) and mirror the durable
 *  tier to localStorage (which fires a `storage` event in other tabs). */
export function persistView(state: PersistedView): void {
  try {
    const params = new URLSearchParams(window.location.search)
    setOrDelete(params, 'view', state.view === 'workspace' ? null : state.view)
    setOrDelete(params, 'feature', state.feature)
    setOrDelete(params, 'run', state.run)
    setOrDelete(params, 'dialog', state.dialog)
    // `wf` only qualifies the portify revisit dialog — drop it otherwise.
    setOrDelete(params, 'wf', state.dialog === 'portify' ? state.wf : null)
    // `task` only qualifies the evaluation export dialog — drop it otherwise.
    setOrDelete(params, 'task', state.dialog === 'evaluation' ? state.task : null)
    // `flight` only qualifies the flights view — drop it otherwise.
    setOrDelete(params, 'flight', state.view === 'flights' ? state.flight : null)
    const qs = params.toString()
    const url = `${window.location.pathname}${qs ? `?${qs}` : ''}${window.location.hash}`
    window.history.replaceState(null, '', url)
  } catch { /* ignore */ }
  try {
    // Durable tier only — see the header note on why run/dialog stay URL-local.
    const durable: DurableView = { view: state.view, feature: state.feature }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(durable))
  } catch { /* ignore */ }
}

/** Subscribe to cross-tab view changes (durable tier only). Returns unsubscribe. */
export function onViewChangedInOtherTab(cb: (state: DurableView) => void): () => void {
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
