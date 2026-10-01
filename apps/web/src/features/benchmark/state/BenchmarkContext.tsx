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

  useEffect(() => {
    const connection = connectRecordStream({
      url: wsUrl ?? defaultWsUrl(),
      WebSocketImpl,
      reads: readsRef.current,
      decode: (frame) => frameToAction(frame as BenchmarkStreamFrame),
      recordId: (action) => action.type === 'update' || action.type === 'removed' ? action.benchmarkId : null,
      dispatch: (action) => dispatchRef.current(action),
      onConnection: (status) => dispatchRef.current({ type: 'connection', status }),
    })
    return () => connection.close()
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
    const reads = readsRef.current
    const token = reads.begin(id)
    if (!token) return
    try {
      const manifest = await api.getBenchmark(id)
      if (manifest && reads.current(id, token)) dispatchRef.current({ type: 'update', benchmarkId: id, manifest })
    } catch {
      /* leave it unhydrated — the caller shows a loading/empty state */
    } finally {
      reads.finish(id, token)
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
