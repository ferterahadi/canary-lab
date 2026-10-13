import { createContext, useCallback, useContext, useMemo, type ReactNode } from 'react'
import * as benchmarkApi from '@/shared/api/benchmark'
import { defaultWsBase } from '@/shared/api/reconnecting-socket'
import { useRecordDetail, useRecordIndexStore } from '@/shared/state/record-index-store'
import type { BenchmarkManifest, BenchmarkIndexEntry, SabotageLevel } from '@shared/benchmark-index'
import { benchmarkIndex } from './benchmark-state'

// Benchmark store mirrors RunsContext: a `/ws/benchmark`-fed reducer for the
// index + per-benchmark manifests, plus a one-shot `startBenchmark` action.
// Per-arm run detail flows through RunsContext (arms are real runs).

type BenchmarkStore = ReturnType<typeof useRecordIndexStore<BenchmarkIndexEntry, BenchmarkManifest, 'benchmarks', 'benchmarkId'>>

interface BenchmarkContextValue extends BenchmarkStore {
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
  const { state, hydration } = useRecordIndexStore({
    index: benchmarkIndex,
    url: wsUrl ?? defaultWsUrl(),
    WebSocketImpl,
    read: benchmarkApi.getBenchmark,
    errorMessage: 'Could not load benchmark',
  })

  const startBenchmark = useCallback(
    async (input: { feature: string; skill: string; level: SabotageLevel; iterations: number; agent?: 'claude' | 'codex' }) => {
      const { benchmarkId } = await benchmarkApi.startBenchmark(input)
      return benchmarkId
    },
    [],
  )

  const abortBenchmark = useCallback(async (id: string) => {
    await benchmarkApi.abortBenchmark(id)
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
  return useRecordDetail(state.details, hydration, id)
}

function defaultWsUrl(): string {
  // The app's one origin→ws-base helper, rather than a fourth copy of the same
  // protocol/host derivation.
  return `${defaultWsBase()}/ws/benchmark`
}
