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
// lives in the workspace runs column. `flight-start` is the stage-entry
// launcher — feature-scoped (the durable `feature` param qualifies it) and
// rebuilt from GET /api/flights/entry, so a cold load is coherent.
// `flight-new` is the new-flight launcher (intent + repo picker, no feature
// yet — the "+ New" action) — needs only the features list, so a cold load is
// coherent too. The former `evaluation` dialog is gone (R29) — export progress
// lives on the flight's Evaluation Report stage (?view=flights&flight=…) and
// the run detail's Evaluation panel (?feature=…&run=…), both already routed.
// `add-test` and `portify` are gone too (R50): flight is the one GUI entry —
// AddTestWizard was deleted outright, and the portify workflow view survives
// only as an EMBEDDED surface (the Ports tab's active-workflow button,
// collision recovery, benchmark), opened ephemerally, never by URL. The flight
// stopped being one of those entries: Parallel readiness drills to the Ports
// tab (?dialog=config&tab=ports), not the wizard.
// `draft` reopens a live external authoring draft (an MCP agent authoring a
// feature's specs) by its `draft` id qualifier — the draft record is
// server-persisted (GET /api/tests/draft), so a cold load rebuilds it.
// `flight-fresh` is the launcher in START-FRESH intent (R76): same dialog as
// `flight-start`, but scoped to the one job of changing intent/repos — it needs
// its own route value so a refresh restores that intent instead of dropping the
// user back into the re-entry picker.
// `demo` is retained as the route key for Getting Started. Its optional core
// demos, secondary catalog, shared activity and fixture actions come from
// GET /api/onboarding.
// Routed because it is the workspace's first screen and a refresh mid-choice
// should not lose it.
// `settings` is Project Settings (the features column's gear). Workspace-scoped
// rather than feature-scoped, and rebuilt entirely from GET /api/project-config,
// so a cold load needs nothing this tab happened to be holding.
export type RouteDialog = 'config' | 'verification' | 'flight-start' | 'flight-fresh' | 'flight-new' | 'draft' | 'demo' | 'settings'

/** The Feature-config dialog's tabs — the `tab` qualifier for `dialog=config`.
 *  Routed because entry points land on different tabs (the run detail opens
 *  Playwright, a flight's Parallel-readiness stage opens Ports), and switching
 *  tabs inside the dialog is a place you can come back to. */
export type ConfigTab = 'general' | 'repos' | 'ports' | 'envsets' | 'playwright'

/** Which tab the run detail should OPEN on when another view links into a run —
 *  the `runtab` qualifier for `run`. Only cross-view arrivals are listed, not the
 *  whole tab set: a flight's Test Run stage reports the repairs a run captured
 *  and sends them to that run's Changes tab. Tab switches made INSIDE the run
 *  detail stay local to it (unrouted), exactly as before — this carries the
 *  arrival intent, the same way `test` does. */
export type RunArrivalTab = 'changes'

/** What a drill-through wants the run detail to land on. `test` is a run-summary
 *  failed-entry name (R82 — the Playwright tab, scrolled to that failure) and
 *  takes precedence over `tab`, because naming a failure already names a tab.
 *  Both absent = the detail's own default (Overview). */
export interface RunOpenTarget {
  test?: string
  tab?: RunArrivalTab
}

export interface PersistedView {
  view: WorkspaceView
  feature: string | null
  /** Selected run id (URL only). */
  run: string | null
  /** Open routed dialog, if any (URL only). */
  dialog: RouteDialog | null
  /** Flight id qualifier for `view: 'flights'` — which flight detail to open
   *  (URL only; absent = the flights landing list). */
  flight: string | null
  /** Stage qualifier for `flight` — which stage of that flight is selected
   *  (URL only; dropped unless a flight is open). Absent = follow-mode, where
   *  the detail auto-picks the stage that needs eyes.
   *
   *  Routed because the stage IS a place: a drill-through (coverage ledger, run
   *  detail) replaces the whole flight view, so without this the way back
   *  re-ran the auto-pick and landed on the last done stage — usually Evaluation
   *  Report — instead of the stage the drill-through left from. */
  flightStage: string | null
  /** Draft id qualifier for `dialog: 'draft'` — which authoring draft to reopen
   *  (URL only; dropped unless the draft dialog is the open one). */
  draft: string | null
  /** Tab qualifier for `dialog: 'config'` — which config tab is open
   *  (URL only; dropped unless the config dialog is the open one). */
  configTab: ConfigTab | null
  /** Test qualifier for `run` — WHICH failing test the run detail should land on
   *  (URL only; dropped unless a run is selected). R82: a flight's Test Run stage
   *  lists the failures as a summary and clicking one opens it here, so the
   *  destination has to carry which one was clicked. The value is the run
   *  summary's failed-entry `name`, the same key the Playwright tab matches
   *  playback tests on. An unknown name simply doesn't match — the tab opens
   *  unscrolled rather than blank. */
  focusTest: string | null
  /** Tab qualifier for `run` — which run-detail tab a drill-through asked for
   *  (URL only; dropped unless a run is selected, and an unknown value is
   *  ignored rather than rendering a blank pane). */
  runTab: RunArrivalTab | null
  /** R83: the flight a drill-through came FROM (URL only; dropped on the flights
   *  view, where it would point at the screen you're already on). A flight's
   *  stage drill-throughs switch the top-level view outright — the coverage
   *  ledger and the run detail are views, not children of the flight — so
   *  without this the destination has no idea it was opened from a flight and
   *  its exit dumps you in the workspace. Carried in the URL rather than React
   *  state so a refresh on the destination keeps the way back. Value is whatever
   *  `flight` held: a real flight id or a `feature:<name>` derived token. */
  returnFlight: string | null
}

/** The cross-tab/localStorage-mirrored subset — the durable nav tier only. */
export type DurableView = Pick<PersistedView, 'view' | 'feature'>

const STORAGE_KEY = 'cl.workspace.view'
const VIEWS: WorkspaceView[] = ['workspace', 'cleanup', 'coverage', 'flights']
const DIALOGS: RouteDialog[] = ['config', 'verification', 'flight-start', 'flight-fresh', 'flight-new', 'draft', 'demo', 'settings']
const CONFIG_TABS: ConfigTab[] = ['general', 'repos', 'ports', 'envsets', 'playwright']
const RUN_ARRIVAL_TABS: RunArrivalTab[] = ['changes']

function isView(v: string | null): v is WorkspaceView {
  return v != null && (VIEWS as string[]).includes(v)
}

function parseDialog(v: string | null): RouteDialog | null {
  return v != null && (DIALOGS as string[]).includes(v) ? (v as RouteDialog) : null
}

function parseConfigTab(v: string | null): ConfigTab | null {
  return v != null && (CONFIG_TABS as string[]).includes(v) ? (v as ConfigTab) : null
}

function parseRunArrivalTab(v: string | null): RunArrivalTab | null {
  return v != null && (RUN_ARRIVAL_TABS as string[]).includes(v) ? (v as RunArrivalTab) : null
}

function setOrDelete(params: URLSearchParams, key: string, value: string | null): void {
  if (value) params.set(key, value)
  else params.delete(key)
}

const EMPTY: PersistedView = { view: 'workspace', feature: null, run: null, dialog: null, flight: null, flightStage: null, draft: null, configTab: null, focusTest: null, runTab: null, returnFlight: null }

/** Read the persisted view, URL first (authoritative on load), then localStorage
 *  (durable tier only — run/dialog are never mirrored there). */
export function readPersistedView(): PersistedView {
  // URL wins — it's what a refresh, a copy-pasted/new tab, or a deep link carries.
  try {
    const params = new URLSearchParams(window.location.search)
    const v = params.get('view')
    const feature = params.get('feature') || null
    const run = params.get('run') || null
    const dialog = parseDialog(params.get('dialog'))
    // `flight` only qualifies the flights view — dropped elsewhere.
    const flight = v === 'flights' ? params.get('flight') || null : null
    // `stage` only qualifies an open flight — dropped elsewhere. Left unvalidated
    // here (this module knows nothing of stage keys); the nav layer parses it and
    // an unknown name falls back to follow-mode.
    const flightStage = flight ? params.get('stage') || null : null
    // `draft` only qualifies the draft dialog — dropped elsewhere.
    const draft = dialog === 'draft' ? params.get('draft') || null : null
    // `tab` only qualifies the config dialog — dropped elsewhere, and an
    // unknown tab name is ignored (falls back to the entry point's default).
    const configTab = dialog === 'config' ? parseConfigTab(params.get('tab')) : null
    // `test` only qualifies a selected run — dropped elsewhere.
    const focusTest = run ? params.get('test') || null : null
    // `runtab` qualifies a selected run too — an unknown tab name is ignored, so
    // the detail opens on its own default instead of a pane that doesn't exist.
    const runTab = run ? parseRunArrivalTab(params.get('runtab')) : null
    // `from` names the flight a drill-through left — meaningless on the flights
    // view itself, dropped there.
    const returnFlight = v === 'flights' ? null : params.get('from') || null
    // A bare `view` (workspace) is omitted from the URL, so treat any other
    // routed param as evidence the URL is authoritative for this load too.
    if (isView(v)) return { view: v, feature, run, dialog, flight, flightStage, draft, configTab, focusTest, runTab, returnFlight }
    if (feature || run || dialog || returnFlight) return { view: 'workspace', feature, run, dialog, flight: null, flightStage: null, draft, configTab, focusTest, runTab, returnFlight }
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
    // `wf` qualified the retired portify dialog (R50) and `task` the retired
    // evaluation dialog (R29) — clear both from stale URLs so old deep links
    // don't carry dead params forward.
    setOrDelete(params, 'wf', null)
    setOrDelete(params, 'task', null)
    // `flight` only qualifies the flights view — drop it otherwise.
    setOrDelete(params, 'flight', state.view === 'flights' ? state.flight : null)
    // `stage` only qualifies an OPEN flight — drop it on the flights landing
    // list and off the view entirely, so a stage pick can't outlive its flight.
    setOrDelete(params, 'stage', state.view === 'flights' && state.flight ? state.flightStage : null)
    // `draft` only qualifies the draft dialog — drop it otherwise.
    setOrDelete(params, 'draft', state.dialog === 'draft' ? state.draft : null)
    // `tab` only qualifies the config dialog — drop it otherwise.
    setOrDelete(params, 'tab', state.dialog === 'config' ? state.configTab : null)
    // `test` only qualifies a selected run — drop it otherwise, so switching runs
    // can't leave a previous run's failure pinned in the URL.
    setOrDelete(params, 'test', state.run ? state.focusTest : null)
    // Same rule for the arrival tab: it belongs to the run in the URL, so
    // switching runs can't leave a previous drill-through's tab pinned.
    setOrDelete(params, 'runtab', state.run ? state.runTab : null)
    // `from` is dropped on the flights view — arriving at a flight IS the return,
    // so keeping it would leave a back-link to the screen you're already on.
    setOrDelete(params, 'from', state.view === 'flights' ? null : state.returnFlight)
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
