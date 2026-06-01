import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, type ReactNode } from 'react'
import * as api from '../api/client'
import type {
  DisplayStatus,
  RunDetail,
  RunIndexEntry,
  RunStatus,
  TransientAction,
} from '../api/types'
import { deriveDisplayStatus } from '../lib/run-actions'
import { isActiveRunStatus } from '../../../../shared/run-state'
import {
  errorMessage,
  frameToAction,
  initialRunsState,
  runsReducer,
  type ConnectionState,
  type RunsState,
  type RunsStreamFrame,
} from './runs-state'

// Single React-side store for everything runs-related: the index list, the
// per-run details, and the in-flight transient flags ("aborting" /
// "deleting" / etc.). Sourced from `/ws/runs` push frames so the browser
// never polls. HTTP is reserved for one-shot mutations (start / abort /
// delete) — and even those just trigger the server to push the resulting
// state through the WS. The pure reducer + frame-mapper live in
// `runs-state.ts` so they're testable without jsdom.

export type { ConnectionState } from './runs-state'

// ─── Context ─────────────────────────────────────────────────────────────

interface RunsContextValue {
  state: RunsState
  /** One-shot HTTP refresh of the runs index. Used as a fallback when the
   *  WS is `disconnected` so an action result still becomes visible. */
  refresh: () => Promise<void>
  /** Start a new run. The server's response triggers a WS `update` frame
   *  with the run's initial detail, so the row appears immediately. Returns
   *  the new runId, or throws on failure. `isolation` resolves a same-repo
   *  collision: 'worktree' isolates + runs now, 'queue' waits. */
  startRun: (feature: string, env?: string, isolation?: 'worktree' | 'queue', mode?: 'test' | 'boot') => Promise<string>
  startVerification: (
    feature: string,
    input: { configId?: string; targetUrls?: Record<string, string>; playwrightEnvsetId?: string },
  ) => Promise<string>
  /** Lazily hydrate a run detail that was omitted from the initial WS
   *  snapshot. Terminal runs use this path so selecting historical rows does
   *  not leave the detail pane waiting forever. */
  loadRunDetail: (runId: string) => Promise<void>
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

const RECONNECT_INITIAL_MS = 500
const RECONNECT_MAX_MS = 10_000

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
  const detailLoadsRef = useRef<Set<string>>(new Set())

  // ── WebSocket lifecycle ───────────────────────────────────────────
  useEffect(() => {
    const url = wsUrl ?? defaultWsUrl()
    const Ctor = WebSocketImpl ?? WebSocket
    let socket: WebSocket | null = null
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null
    let backoff = RECONNECT_INITIAL_MS
    let cancelled = false

    const connect = (): void => {
      /* v8 ignore next -- cleanup clears reconnect timers before this closure can run cancelled. */
      if (cancelled) return
      try {
        socket = new Ctor(url)
      } catch {
        scheduleReconnect()
        return
      }
      socket.onopen = () => {
        backoff = RECONNECT_INITIAL_MS
        dispatchRef.current({ type: 'connection', status: 'live' })
      }
      socket.onmessage = (e) => {
        let frame: RunsStreamFrame
        try {
          frame = JSON.parse(typeof e.data === 'string' ? e.data : String(e.data))
        } catch {
          return
        }
        const action = frameToAction(frame)
        if (action) dispatchRef.current(action)
      }
      socket.onerror = () => {
        // `onclose` will fire next; let the reconnect path live there to
        // avoid double-scheduling.
      }
      socket.onclose = () => {
        if (cancelled) return
        dispatchRef.current({ type: 'connection', status: 'reconnecting' })
        scheduleReconnect()
      }
    }

    const scheduleReconnect = (): void => {
      /* v8 ignore next -- callers guard cleanup through cleared timers or socket close. */
      if (cancelled) return
      reconnectTimer = setTimeout(() => {
        // After multiple rounds of growing backoff, surface the
        // disconnect to the user. They can still click around the
        // cached state; HTTP fallback covers actions.
        if (backoff >= RECONNECT_MAX_MS) {
          dispatchRef.current({ type: 'connection', status: 'disconnected' })
        }
        backoff = Math.min(backoff * 2, RECONNECT_MAX_MS)
        connect()
      }, backoff)
    }

    connect()

    return () => {
      cancelled = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      try { socket?.close() } catch { /* already closed */ }
    }
  }, [wsUrl, WebSocketImpl])

  // ── HTTP fallback ─────────────────────────────────────────────────

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const runs = await api.listRuns()
      dispatch({ type: 'http-list', runs })
    } catch { /* surfaced via connection state */ }
  }, [])

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
        dispatch({ type: 'error-set', runId, message: errorMessage(err) })
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

  const startRun = useCallback(async (feature: string, env?: string, isolation?: 'worktree' | 'queue', mode?: 'test' | 'boot'): Promise<string> => {
    const boot = mode === 'boot'
    const opts = env || isolation || boot
      ? { ...(env ? { env } : {}), ...(isolation ? { isolation } : {}), ...(boot ? { mode: 'boot' as const } : {}) }
      : undefined
    const { runId } = await api.startRun(feature, opts)
    if (state.connection !== 'live') await refresh()
    return runId
  }, [refresh, state.connection])

  const startVerification = useCallback(async (
    feature: string,
    input: { configId?: string; targetUrls?: Record<string, string>; playwrightEnvsetId?: string },
  ): Promise<string> => {
    const { runId } = await api.executeVerification(feature, input)
    if (state.connection !== 'live') await refresh()
    return runId
  }, [refresh, state.connection])

  const loadRunDetail = useCallback(async (runId: string): Promise<void> => {
    if (detailLoadsRef.current.has(runId)) return
    detailLoadsRef.current.add(runId)
    try {
      const detail = await api.getRunDetail(runId)
      dispatch({ type: 'http-detail', runId, detail })
    } catch {
      // Missing detail is non-fatal for the global run store. The list row
      // remains usable, and a future WS update can still hydrate the detail.
    } finally {
      detailLoadsRef.current.delete(runId)
    }
  }, [])

  const abort = useCallback((runId: string) => runAction(runId, 'aborting', () => api.stopRun(runId)), [runAction])
  const deleteRun = useCallback((runId: string) => runAction(runId, 'deleting', () => api.deleteRun(runId)), [runAction])
  const pauseHeal = useCallback((runId: string) => runAction(runId, 'pausing', () => api.pauseHealRun(runId)), [runAction])
  const cancelHeal = useCallback((runId: string) => runAction(runId, 'cancelling-heal', () => api.cancelHealRun(runId)), [runAction])

  const clearError = useCallback((runId: string) => {
    dispatch({ type: 'error-clear', runId })
  }, [])

  const value = useMemo<RunsContextValue>(() => ({
    state,
    refresh,
    startRun,
    startVerification,
    loadRunDetail,
    abort,
    delete: deleteRun,
    pauseHeal,
    cancelHeal,
    clearError,
  }), [state, refresh, startRun, startVerification, loadRunDetail, abort, deleteRun, pauseHeal, cancelHeal, clearError])

  return <RunsContext.Provider value={value}>{children}</RunsContext.Provider>
}

// ─── Hooks ───────────────────────────────────────────────────────────────

function useRunsContext(): RunsContextValue {
  const ctx = useContext(RunsContext)
  if (!ctx) throw new Error('useRunsContext must be used inside <RunsProvider>')
  return ctx
}

export interface UseRunsResult {
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
  startRun: (feature: string, env?: string, isolation?: 'worktree' | 'queue', mode?: 'test' | 'boot') => Promise<string>
  /** Start a deployment verification. */
  startVerification: (
    feature: string,
    input: { configId?: string; targetUrls?: Record<string, string>; playwrightEnvsetId?: string },
  ) => Promise<string>
  // ── Per-run actions (the runId is the first arg). The parent can
  //    dispatch these for any row without needing a child component. ──
  abort: (runId: string) => Promise<void>
  delete: (runId: string) => Promise<void>
  pauseHeal: (runId: string) => Promise<void>
  cancelHeal: (runId: string) => Promise<void>
  clearError: (runId: string) => void
}

export function useRuns(): UseRunsResult {
  const ctx = useRunsContext()
  return {
    runs: ctx.state.runs,
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
  useEffect(() => {
    if (!runId || !indexed) return
    if (!detail) {
      void ctx.loadRunDetail(runId)
    }
    if (!isActiveRunStatus(status)) return
    const timer = setInterval(() => {
      void ctx.loadRunDetail(runId)
    }, 1000)
    return () => clearInterval(timer)
  }, [ctx.loadRunDetail, detail, indexed, runId, status])
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
  const entry = state.runs.find((r) => isActiveRunStatus(r.status)) ?? null
  const detail = entry ? (state.details[entry.runId] ?? null) : null
  return { runId: entry?.runId ?? null, entry, detail }
}

// Every run that occupies resources or a queue slot right now: running,
// healing, or queued. Concurrent runs are allowed, so this can hold several.
// Drives the top-right runs control + its badge count.
export function useActiveRuns(): { runs: RunIndexEntry[]; count: number } {
  const { state } = useRunsContext()
  const runs = state.runs.filter((r) => isActiveRunStatus(r.status) || r.status === 'queued')
  return { runs, count: runs.length }
}

// Boot-only sessions that are currently live (booting or held). These are
// surfaced in the global Services pill, NOT the Runs list — a boot is not a
// test run. `executionType === 'boot'` is the discriminator.
export function useActiveBootSessions(): { sessions: RunIndexEntry[]; count: number } {
  const { state } = useRunsContext()
  const sessions = state.runs.filter(
    (r) => r.executionType === 'boot' && (isActiveRunStatus(r.status) || r.status === 'queued'),
  )
  return { sessions, count: sessions.length }
}

// Read-only access to the per-run detail map (manifests + summaries). Lets the
// runs dialog surface allocated ports without calling useRun() per row (which
// would break the Rules of Hooks inside a list map).
export function useRunDetails(): Record<string, RunDetail> {
  return useRunsContext().state.details
}

// ─── Internals ───────────────────────────────────────────────────────────

function defaultWsUrl(): string {
  /* v8 ignore next -- React DOM tests require a browser-like window. */
  if (typeof window === 'undefined') return 'ws://localhost/ws/runs'
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${window.location.host}/ws/runs`
}
