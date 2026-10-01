import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from 'react'
import { createBenchmarkHydration } from './benchmark-hydration'
import * as api from '@/shared/api/client'
import { createObservedReads } from '@/shared/state/observed-reads'
import { defaultWsBase } from '@/shared/api/reconnecting-socket'
import { connectRecordStream } from '@/shared/state/record-stream'
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
  hydration: ReturnType<typeof createBenchmarkHydration>
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
  const readsRef = useRef(createObservedReads())

  const stateRef = useRef(state)
  stateRef.current = state
  const hydration = useMemo(() => createBenchmarkHydration({
    reads: readsRef.current, read: api.getBenchmark,
    apply: (action) => dispatchRef.current(action),
    hasDetail: (id) => Boolean(stateRef.current.details[id]),
  }), [])
  useEffect(() => {
    hydration.start()
    const connection = connectRecordStream({
      url: wsUrl ?? defaultWsUrl(),
      WebSocketImpl,
      reads: readsRef.current,
      decode: (frame) => frameToAction(frame as BenchmarkStreamFrame),
      recordId: (action) => action.type === 'update' || action.type === 'removed' ? action.benchmarkId : null,
      dispatch: (action) => { dispatchRef.current(action); hydration.observe(action) },
      onConnection: (status) => dispatchRef.current({ type: 'connection', status }),
    })
    return () => { connection.close(); hydration.stop() }
  }, [wsUrl, WebSocketImpl, hydration])

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

  const loadBenchmark = hydration.load

  const value = useMemo<BenchmarkContextValue>(
    () => ({ state, hydration, startBenchmark, abortBenchmark, loadBenchmark }),
    [state, hydration, startBenchmark, abortBenchmark, loadBenchmark],
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

/** Mounted consumers share detail demand and recovery with the provider. */
export function useBenchmarkDetail(id: string | null | undefined) {
  const { state, hydration } = useBenchmarkContext()
  const status = useSyncExternalStore(hydration.subscribe, () => hydration.snapshot(id))
  useEffect(() => id ? hydration.watch(id) : undefined, [id, hydration])
  const manifest = id ? state.details[id] : undefined
  return {
    manifest,
    loading: Boolean(id && !manifest && (status.status === 'idle' || status.status === 'loading')),
    error: status.error,
    missing: status.status === 'missing',
    retry: () => { if (id) hydration.retry(id) },
  }
}

function defaultWsUrl(): string {
  // The app's one origin→ws-base helper, rather than a fourth copy of the same
  // protocol/host derivation.
  return `${defaultWsBase()}/ws/benchmark`
}
