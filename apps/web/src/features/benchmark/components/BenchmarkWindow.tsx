import { isActiveBenchmarkStatus } from '@shared/benchmark-index'
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { useBenchmark, useBenchmarks } from '../state/BenchmarkContext'
import { ConfigScreen } from './BenchmarkConfigScreen'
import { BenchmarkDetail } from './BenchmarkDetail'
import { FullScreenPage } from '@/shared/ui/PageHeader'

export function BenchmarkWindow({ onClose, onOpenPortify }: { onClose: () => void; onOpenPortify?: (feature: string) => void }) {
  const { startBenchmark, benchmarks } = useBenchmarks()
  // Resume ONLY a live benchmark (so you don't lose a run in progress); when
  // nothing is running, open on the config/sabotage screen — clicking Benchmark
  // should start a fresh one, not resurface a finished/aborted run.
  // (benchmarks are sorted newest-first by the reducer.)
  const live = benchmarks.find(
    (b) => isActiveBenchmarkStatus(b.status),
  )
  const [activeId, setActiveId] = useState<string | null>(live?.benchmarkId ?? null)
  const blocked = !!live

  return (
    // Full-screen — the benchmark is a focused workspace, not a floating modal.
    <FullScreenPage onClose={onClose}>
      {activeId ? (
        <BenchmarkDetail id={activeId} onClose={onClose} onNew={() => setActiveId(null)} />
      ) : (
        <ConfigScreen onClose={onClose} onStarted={setActiveId} startBenchmark={startBenchmark} blocked={blocked} onOpenPortify={onOpenPortify} />
      )}
    </FullScreenPage>
  )
}
