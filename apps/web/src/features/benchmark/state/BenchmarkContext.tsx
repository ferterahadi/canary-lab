import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from 'react'
import * as api from '@/shared/api/client'
import { defaultWsBase } from '@/shared/api/reconnecting-socket'
import type { BenchmarkManifest, SabotageLevel } from '../api/benchmark-types'
import {
  benchmarkReducer,
  initialBenchmarkState,
  frameToAction,
  type BenchmarkState,
  type BenchmarkStreamFrame,
} from './benchmark-state'

// Benchmark store mirrors RunsContext: a `/ws/benchmark`-fed reducer for the
// index + per-benchmark manifests, plus a one-shot `startBenchmark` action.
// Per-arm run detail flows through RunsContext (arms are real runs).

interface BenchmarkContextValue {
  state: BenchmarkState
  startBenchmark: (input: {
    feature: string
    skill: string
    level: SabotageLevel
    iterations: number
    agent?: 'claude' | 'codex'
  }) => Promise<string>
  abortBenchmark: (id: string) => Promise<void>
  /** Fetch a benchmark's full manifest and seed it into `details` — used to
   *  hydrate terminal benchmarks the WS snapshot omits (it only ships details
   *  for active ones). WS `update`s keep active benchmarks fresh after. */
  loadBenchmark: (id: string) => Promise<void>
}

const BenchmarkContext = createContext<BenchmarkContextValue | null>(null)

const RECONNECT_INITIAL_MS = 500
const RECONNECT_MAX_MS = 10_000

export function BenchmarkProvider({
  children,
  wsUrl,
  WebSocketImpl,
}: {
  children: ReactNode
  wsUrl?: string
  WebSocketImpl?: typeof WebSocket
}) {
  const [state, dispatch] = useReducer(benchmarkReducer, initialBenchmarkState)
  const dispatchRef = useRef(dispatch)
  dispatchRef.current = dispatch

  useEffect(() => {
    const url = wsUrl ?? defaultWsUrl()
    const Ctor = WebSocketImpl ?? WebSocket
    let socket: WebSocket | null = null
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null
    let backoff = RECONNECT_INITIAL_MS
    let cancelled = false

    // No `cancelled` guard of its own: its only callers are the initial call
    // below and the reconnect timer, and cleanup clears that timer before its
    // callback can fire. Same shape as RunsContext's socket lifecycle.
    const connect = (): void => {
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
        let frame: BenchmarkStreamFrame
        try {
          frame = JSON.parse(typeof e.data === 'string' ? e.data : String(e.data))
        } catch {
          return
        }
        const action = frameToAction(frame)
        if (action) dispatchRef.current(action)
      }
      socket.onclose = () => {
        if (cancelled) return
        dispatchRef.current({ type: 'connection', status: 'reconnecting' })
        scheduleReconnect()
      }
    }

    // Same reasoning: the constructor's catch runs inside `connect`, and
    // `onclose` checks `cancelled` before it gets here.
    const scheduleReconnect = (): void => {
      reconnectTimer = setTimeout(() => {
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
      try {
        socket?.close()
      } catch {
        /* already closed */
      }
    }
  }, [wsUrl, WebSocketImpl])

  const startBenchmark = useCallback(
    async (input: { feature: string; skill: string; level: SabotageLevel; iterations: number; agent?: 'claude' | 'codex' }) => {
      const { benchmarkId } = await api.startBenchmark(input)
      return benchmarkId
    },
    [],
  )

  const abortBenchmark = useCallback(async (id: string) => {
    await api.abortBenchmark(id)
  }, [])

  const loadBenchmark = useCallback(async (id: string) => {
    try {
      const manifest = await api.getBenchmark(id)
      if (manifest) dispatchRef.current({ type: 'update', benchmarkId: id, manifest })
    } catch {
      /* leave it unhydrated — the caller shows a loading/empty state */
    }
  }, [])

  const value = useMemo<BenchmarkContextValue>(
    () => ({ state, startBenchmark, abortBenchmark, loadBenchmark }),
    [state, startBenchmark, abortBenchmark, loadBenchmark],
  )
  return <BenchmarkContext.Provider value={value}>{children}</BenchmarkContext.Provider>
}

function useBenchmarkContext(): BenchmarkContextValue {
  const ctx = useContext(BenchmarkContext)
  if (!ctx) throw new Error('useBenchmarks must be used inside <BenchmarkProvider>')
  return ctx
}

export function useBenchmarks() {
  const ctx = useBenchmarkContext()
  return {
    benchmarks: ctx.state.benchmarks,
    connection: ctx.state.connection,
    startBenchmark: ctx.startBenchmark,
    abortBenchmark: ctx.abortBenchmark,
    loadBenchmark: ctx.loadBenchmark,
  }
}

export function useBenchmark(id: string | null | undefined): BenchmarkManifest | undefined {
  const ctx = useBenchmarkContext()
  return id ? ctx.state.details[id] : undefined
}

function defaultWsUrl(): string {
  // The app's one origin→ws-base helper, rather than a fourth copy of the same
  // protocol/host derivation.
  return `${defaultWsBase()}/ws/benchmark`
}
