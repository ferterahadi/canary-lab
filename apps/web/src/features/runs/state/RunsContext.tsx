import { createRunDetailObserver } from './run-detail-observer'
import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react'
import * as runsApi from '@/shared/api/runs'
import * as verificationApi from '@/shared/api/verification'
import { createObservedReads } from '@/shared/state/observed-reads'
import type { StageModelChoice } from '@shared/agent-models'
import type { RunDetail, RunsStreamFrame } from '@shared/run-detail'
import type { RunIndexEntry } from '@shared/run-index'
import { deriveDisplayStatus } from '@shared/run-state'
import {
  isActiveRunStatus,
  isUnsettledRunStatus,
  type DisplayStatus,
  type RunStatus,
  type TransientAction,
} from '@shared/run-state'
import { defaultWsBase } from '@/shared/api/reconnecting-socket'
import { useRecordStream, type ConnectionState } from '@/shared/state/record-stream'
import { displayError } from '@/shared/api/error-message'
import {
  frameToAction,
  initialRunsState,
  runsReducer,
  type RunsState,
} from './runs-state'

// Single React-side store for everything runs-related: the index list, the
// per-run details, and the in-flight transient flags ("aborting" /
// "deleting" / etc.). Sourced from `/ws/runs` push frames so the browser
// uses push as its fast path. The existing active-detail recovery read also
// reconciles the index, keeping sidebar badges and detail evidence together
// when an update is missed. The reducer + frame-mapper live in `runs-state.ts`.

// ─── Context ─────────────────────────────────────────────────────────────

/** The run-scoped model plan riding a launch: the two stages a suite run
 *  spawns. Locked into the run's manifest at start (see RunModelPlan). */
export type RunStartModels = { heal?: StageModelChoice; commit?: StageModelChoice }

interface RunsContextValue {
  state: RunsState
  /** One-shot HTTP refresh of the runs index. Used as a fallback when the
   *  WS is `disconnected` so an action result still becomes visible. */
  refresh: () => Promise<void>
  /** Start a new run. The server's response triggers a WS `update` frame
   *  with the run's initial detail, so the row appears immediately. Returns
   *  the new runId, or throws on failure. `isolation` resolves a same-repo
   *  collision: 'worktree' isolates + runs now, 'queue' waits. */
  startRun: (feature: string, env?: string, isolation?: 'worktree' | 'queue', mode?: 'test' | 'boot', models?: RunStartModels) => Promise<string>
  startVerification: (
    feature: string,
    input: { configId?: string; targetUrls?: Record<string, string>; playwrightEnvsetId?: string; bootRunId?: string; gettingStartedSource?: 'internal' | 'external' },
  ) => Promise<string>
  observeRunDetail: (runId: string) => () => void
  observeRunIndex: () => () => void
  indexError: string | null
  /** Action helpers — set the transient flag, call the API, clear the flag
   *  on success/failure. Errors land in `state.errors[runId]`. */
  abort: (runId: string) => Promise<void>
  delete: (runId: string) => Promise<void>
  pauseHeal: (runId: string) => Promise<void>
  cancelHeal: (runId: string) => Promise<void>
  clearError: (runId: string) => void
}

const RunsContext = createContext<RunsContextValue | null>(null)

// ─── Provider ────────────────────────────────────────────────────────────

const RECONNECT_DELAY_MS = 500
const DISCONNECTED_AFTER_ATTEMPTS = 20

export interface RunsProviderProps {
  children: ReactNode
  /** Override the WS URL — primarily a test seam. Defaults to the current
   *  origin's `/ws/runs` (with the right ws:/wss: protocol). */
  wsUrl?: string
  /** Override the WebSocket constructor. Tests pass a fake; production
   *  defaults to the global. */
  WebSocketImpl?: typeof WebSocket
}

export function RunsProvider({ children, wsUrl, WebSocketImpl }: RunsProviderProps) {
  const [state, dispatch] = useReducer(runsReducer, initialRunsState)
  // Stash the latest dispatch in a ref so the long-lived WS connect
  // closure isn't stale across re-renders. Same trick as react-redux'.
  const dispatchRef = useRef(dispatch)
  dispatchRef.current = dispatch
  const detailLoadsRef = useRef(createObservedReads())
  const indexReadsRef = useRef(createObservedReads())
  const [indexError, setIndexError] = useState<string | null>(null)
  const refresh = useCallback(async (): Promise<void> => {
    const reads = indexReadsRef.current
    reads.invalidate('index')
    const token = reads.begin('index')!
    try {
      const runs = await runsApi.listRuns()
      if (reads.current('index', token)) {
        dispatch({ type: 'http-list', runs })
        setIndexError(null)
      }
    } catch (error) {
      if (reads.current('index', token)) setIndexError(displayError(error))
    } finally {
      reads.finish('index', token)
    }
  }, [])
  // Reuse the store's demand-driven recovery scheduler. An open history view
  // reconciles every 15 seconds, including when the latest-run push was lost.
  const [indexObserver] = useState(() => createRunDetailObserver({
    exists: () => true,
    active: () => false,
    read: () => { void refresh() },
    invalidate: () => indexReadsRef.current.invalidate('index'),
    hidden: () => document.visibilityState === 'hidden',
  }))
  const observeRunIndex = useCallback(() => indexObserver.subscribe('index'), [indexObserver])

  const loadRunDetail = useCallback(async (runId: string): Promise<void> => {
    const reads = detailLoadsRef.current
    // The subscription manager owns deduplication; every scheduled round may
    // supersede a hung predecessor, so begin always follows invalidation.
    reads.invalidate(runId)
    const token = reads.begin(runId)!
    try {
      const detail = await runsApi.getRunDetail(runId)
      if (reads.current(runId, token)) {
        dispatch({ type: 'http-detail', runId, detail })
      }
    } catch {
      // Missing detail is non-fatal for the global run store. The list row
      // remains usable, and a future WS update can still hydrate the detail.
    } finally {
      reads.finish(runId, token)
    }
  }, [])

  const stateRef = useRef(state)
  stateRef.current = state
  const [detailObserver] = useState(() => createRunDetailObserver({
    exists: (id) => stateRef.current.runs.some((run) => run.runId === id),
    active: (id) => isActiveRunStatus(stateRef.current.details[id]?.manifest.status ?? stateRef.current.runs.find((run) => run.runId === id)?.status),
    read: (id) => { void loadRunDetail(id) },
    invalidate: (id) => detailLoadsRef.current.invalidate(id),
    hidden: () => document.visibilityState === 'hidden',
  }))
  const connectedOnce = useRef(false)
  const observeRunDetail = useCallback((id: string) => detailObserver.subscribe(id), [detailObserver])
  useEffect(() => { detailObserver.sync() }, [detailObserver, state.runs, state.details])
  useEffect(() => {
    if (state.connection !== 'live') return
    if (connectedOnce.current) {
      detailObserver.refresh()
      indexObserver.refresh()
    }
    connectedOnce.current = true
  }, [detailObserver, indexObserver, state.connection])
  useEffect(() => {
    const refresh = () => {
      detailObserver.refresh()
      indexObserver.refresh()
    }
    window.addEventListener('focus', refresh)
    window.addEventListener('online', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      window.removeEventListener('focus', refresh)
      window.removeEventListener('online', refresh)
      document.removeEventListener('visibilitychange', refresh)
      detailObserver.close()
      indexObserver.close()
    }
  }, [detailObserver, indexObserver])

  useRecordStream({
    url: wsUrl ?? defaultWsUrl(),
    WebSocketImpl,
    reads: detailLoadsRef.current,
    reconnectDelayMs: RECONNECT_DELAY_MS,
    disconnectedAfterAttempts: DISCONNECTED_AFTER_ATTEMPTS,
    coerceMessageData: false,
    decode: (frame) => frame && typeof frame === 'object' ? frameToAction(frame as RunsStreamFrame) ?? null : null,
    recordId: (action) => action.type === 'update' || action.type === 'removed' ? action.runId : null,
    dispatch: (action) => {
      indexReadsRef.current.invalidate('index')
      if (action.type === 'snapshot' || action.type === 'list-changed') setIndexError(null)
      dispatchRef.current(action)
    },
    onConnection: (status) => dispatchRef.current({ type: 'connection', status }),
  })
  useEffect(() => {
    const reads = indexReadsRef.current
    return () => reads.clear()
  }, [wsUrl, WebSocketImpl])

  // ── Actions ───────────────────────────────────────────────────────

  // Wraps an action call with the standard transient → API → error shape.
  // Returns void; errors are surfaced via `state.errors[runId]` so the row
  // chip can render them. The transient is cleared on both paths.
  const runAction = useCallback(
    async (
      runId: string,
      transient: TransientAction,
      call: () => Promise<unknown>,
    ): Promise<void> => {
      dispatch({ type: 'transient-set', runId, action: transient })
      dispatch({ type: 'error-clear', runId })
      try {
        await call()
        // Successful actions wait for the WS `update` / `removed` frame to
        // patch state; we only clear the transient here. If WS is down,
        // fall back to an HTTP refresh so the row updates anyway.
      } catch (err) {
        dispatch({ type: 'error-set', runId, message: displayError(err) })
      } finally {
        dispatch({ type: 'transient-clear', runId })
        // If the WS isn't live, push state forward via HTTP so the user
        // doesn't see a stale row sitting under their cleared transient.
        const conn = state.connection
        if (conn !== 'live') {
          await refresh()
        }
      }
    },
    [refresh, state.connection],
  )

  const startRun = useCallback(async (feature: string, env?: string, isolation?: 'worktree' | 'queue', mode?: 'test' | 'boot', models?: RunStartModels): Promise<string> => {
    const boot = mode === 'boot'
    const opts = env || isolation || boot || models
      ? { ...(env ? { env } : {}), ...(isolation ? { isolation } : {}), ...(boot ? { mode: 'boot' as const } : {}), ...(models ? { models } : {}) }
      : undefined
    const { runId } = await runsApi.startRun(feature, opts)
    if (state.connection !== 'live') await refresh()
    return runId
  }, [refresh, state.connection])

  const startVerification = useCallback(async (
    feature: string,
    input: { configId?: string; targetUrls?: Record<string, string>; playwrightEnvsetId?: string; bootRunId?: string; gettingStartedSource?: 'internal' | 'external' },
  ): Promise<string> => {
    const { runId } = await verificationApi.executeVerification(feature, input)
    if (state.connection !== 'live') await refresh()
    return runId
  }, [refresh, state.connection])

  const abort = useCallback((runId: string) => runAction(runId, 'aborting', () => runsApi.stopRun(runId)), [runAction])
  const deleteRun = useCallback((runId: string) => runAction(runId, 'deleting', () => runsApi.deleteRun(runId)), [runAction])
  const pauseHeal = useCallback((runId: string) => runAction(runId, 'pausing', () => runsApi.pauseHealRun(runId)), [runAction])
  const cancelHeal = useCallback((runId: string) => runAction(runId, 'cancelling-heal', () => runsApi.cancelHealRun(runId)), [runAction])

  const clearError = useCallback((runId: string) => {
    dispatch({ type: 'error-clear', runId })
  }, [])

  const value = useMemo<RunsContextValue>(() => ({
    state,
    refresh,
    startRun,
    startVerification,
    observeRunDetail,
    observeRunIndex,
    indexError,
    abort,
    delete: deleteRun,
    pauseHeal,
    cancelHeal,
    clearError,
  }), [state, refresh, startRun, startVerification, observeRunDetail, observeRunIndex, indexError, abort, deleteRun, pauseHeal, cancelHeal, clearError])

  return <RunsContext.Provider value={value}>{children}</RunsContext.Provider>
}

// ─── Hooks ───────────────────────────────────────────────────────────────

function useRunsContext(): RunsContextValue {
  const ctx = useContext(RunsContext)
  if (!ctx) throw new Error('useRunsContext must be used inside <RunsProvider>')
  return ctx
}

export interface UseRunsResult {
  indexLoaded: boolean
  indexError: string | null
  runs: RunIndexEntry[]
  connection: ConnectionState
  /** Per-run transient flags. Map shape avoids forcing the consumer to
   *  call `useRun(runId)` once per row (which would violate Rules of
   *  Hooks inside a `.map`). */
  transients: Record<string, TransientAction>
  /** Per-run error messages from failed actions. Same Map-shape rationale
   *  as `transients`. */
  errors: Record<string, string>
  /** Manually refresh the index list. Primarily used internally by actions
   *  in disconnected mode; consumers usually don't need to call this. */
  refresh: () => Promise<void>
  /** Start a new run. `isolation` resolves a same-repo collision. */
  startRun: (feature: string, env?: string, isolation?: 'worktree' | 'queue', mode?: 'test' | 'boot', models?: RunStartModels) => Promise<string>
  /** Start a deployment verification. */
  startVerification: (
    feature: string,
    input: { configId?: string; targetUrls?: Record<string, string>; playwrightEnvsetId?: string; bootRunId?: string; gettingStartedSource?: 'internal' | 'external' },
  ) => Promise<string>
  // ── Per-run actions (the runId is the first arg). The parent can
  //    dispatch these for any row without needing a child component. ──
  abort: (runId: string) => Promise<void>
  delete: (runId: string) => Promise<void>
  pauseHeal: (runId: string) => Promise<void>
  cancelHeal: (runId: string) => Promise<void>
  clearError: (runId: string) => void
}

export function useRuns({ reconcile = false }: { reconcile?: boolean } = {}): UseRunsResult {
  const ctx = useRunsContext()
  useEffect(() => reconcile ? ctx.observeRunIndex() : undefined, [reconcile, ctx.observeRunIndex])
  return {
    runs: ctx.state.runs,
    indexLoaded: ctx.state.indexLoaded,
    indexError: ctx.indexError,
    connection: ctx.state.connection,
    transients: ctx.state.transients,
    errors: ctx.state.errors,
    refresh: ctx.refresh,
    startRun: ctx.startRun,
    startVerification: ctx.startVerification,
    abort: ctx.abort,
    delete: ctx.delete,
    pauseHeal: ctx.pauseHeal,
    cancelHeal: ctx.cancelHeal,
    clearError: ctx.clearError,
  }
}

export interface UseRunResult {
  /** Server-known detail (manifest + summary). Undefined until the WS
   *  pushes the first `update` for this run, or the action layer does an
   *  HTTP fallback. */
  detail: RunDetail | undefined
  /** Server-known persisted status (or undefined if detail isn't loaded
   *  yet). For the value to render in a badge, prefer `displayStatus`. */
  status: RunStatus | undefined
  /** In-flight UI action, if any. Local to this browser session — never
   *  mirrored to the server. */
  transient: TransientAction | null
  /** Status overlaid with the transient action so the badge always reads
   *  the latest user intent. Equals `status` when no action is in flight. */
  displayStatus: DisplayStatus | undefined
  /** Last error from a failed action against this run, or null. */
  error: string | null
}

export function useRun(runId: string | null | undefined): UseRunResult {
  const ctx = useRunsContext()
  // The list entry is the cheap fallback for status when detail hasn't
  // arrived yet — keeps row badges from flickering empty during reconnect.
  const detail = runId ? ctx.state.details[runId] : undefined
  const indexed = runId ? ctx.state.runs.find((r) => r.runId === runId) : undefined
  const status = detail?.manifest.status ?? indexed?.status
  const available = !!indexed
  useEffect(() => {
    if (!runId || !available) return
    return ctx.observeRunDetail(runId)
  }, [ctx.observeRunDetail, available, runId])
  if (!runId) {
    return { detail: undefined, status: undefined, transient: null, displayStatus: undefined, error: null }
  }
  const transient = ctx.state.transients[runId] ?? null
  const displayStatus = status ? deriveDisplayStatus(status, transient) : undefined
  const error = ctx.state.errors[runId] ?? null
  return { detail, status, transient, displayStatus, error }
}

export interface UseRunActionsResult {
  abort: () => Promise<void>
  delete: () => Promise<void>
  pauseHeal: () => Promise<void>
  cancelHeal: () => Promise<void>
  clearError: () => void
}

export function useRunActions(runId: string): UseRunActionsResult {
  const ctx = useRunsContext()
  return {
    abort: useCallback(() => ctx.abort(runId), [ctx, runId]),
    delete: useCallback(() => ctx.delete(runId), [ctx, runId]),
    pauseHeal: useCallback(() => ctx.pauseHeal(runId), [ctx, runId]),
    cancelHeal: useCallback(() => ctx.cancelHeal(runId), [ctx, runId]),
    clearError: useCallback(() => ctx.clearError(runId), [ctx, runId]),
  }
}

// Globally-active run helper — at most one run is `running` or `healing` at
// a time. Used by GlobalStatusBar and to gate the Run Now button.
export interface UseGlobalActiveRunResult {
  runId: string | null
  entry: RunIndexEntry | null
  detail: RunDetail | null
}

export function useGlobalActiveRun(): UseGlobalActiveRunResult {
  const { state } = useRunsContext()
  // Benchmark runs (arms + the validity-gate trial) drive the benchmark window
  // and historical auxiliary cells had their own owner — never surface one as the
  // globally-active run. A boot session IS surfaced: it is the user's own.
  const entry = state.runs.find((r) => isActiveRunStatus(r.status) && r.executionType !== 'benchmark' && r.executionType !== 'robustness') ?? null
  const detail = entry ? (state.details[entry.runId] ?? null) : null
  return { runId: entry?.runId ?? null, entry, detail }
}

// Every run that occupies resources or a queue slot right now: running,
// healing, or queued. Concurrent runs are allowed, so this can hold several.
// Drives the top-right runs control + its badge count.
//
// Memoized on `state.runs`, not recomputed per render: consumers put the
// returned array in dep arrays (`useFeatureWorkState` memoizes on it), and a
// fresh `.filter()` identity every render silently defeated every one of those
// memos — the exact unstable-dep pattern behind the 3877ms workspace-load
// incident.
export function useActiveRuns(): { runs: RunIndexEntry[]; count: number } {
  const { state } = useRunsContext()
  return useMemo(() => {
    const runs = state.runs.filter((r) => isUnsettledRunStatus(r.status))
    return { runs, count: runs.length }
  }, [state.runs])
}

// Boot-only sessions that are currently live (booting or held). These are
// surfaced in the global Services pill, NOT the Runs list — a boot is not a
// test run. `executionType === 'boot'` is the discriminator.
// Same memo rationale as useActiveRuns above.
export function useActiveBootSessions(): { sessions: RunIndexEntry[]; count: number } {
  const { state } = useRunsContext()
  return useMemo(() => {
    const sessions = state.runs.filter(
      (r) => r.executionType === 'boot' && isUnsettledRunStatus(r.status),
    )
    return { sessions, count: sessions.length }
  }, [state.runs])
}

// Deployed-env verification runs that are live right now (record-only, no
// heal). Surfaced by the global Deploy-check pill (R27) — a verify is neither
// a test run nor a boot. `executionType === 'verify'` is the discriminator.
export function useActiveVerifyRuns(): { runs: RunIndexEntry[]; count: number } {
  const { state } = useRunsContext()
  const runs = state.runs.filter(
    (r) => r.executionType === 'verify' && isUnsettledRunStatus(r.status),
  )
  return { runs, count: runs.length }
}

// Read-only access to the per-run detail map (manifests + summaries). Lets the
// runs dialog surface allocated ports without calling useRun() per row (which
// would break the Rules of Hooks inside a list map).
export function useRunDetails(): Record<string, RunDetail> {
  return useRunsContext().state.details
}

// ─── Internals ───────────────────────────────────────────────────────────

function defaultWsUrl(): string {
  // Shares the app's one origin→ws-base helper rather than re-deriving it: this
  // was a second copy of the same protocol/host logic, including its own
  // no-window fallback.
  return `${defaultWsBase()}/ws/runs`
}
