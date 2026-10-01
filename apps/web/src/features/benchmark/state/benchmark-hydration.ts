import type { BenchmarkManifest } from '../api/benchmark-types'
import { createDetailHydration } from '@/shared/state/detail-hydration'
import type { createObservedReads } from '@/shared/state/observed-reads'
import type { BenchmarkAction } from './benchmark-state'

/** Benchmark supplies domain actions; the provider owns manifests and read tokens. */
export function createBenchmarkHydration({ reads, read, apply, hasDetail }: {
  reads: ReturnType<typeof createObservedReads>
  read: (id: string) => Promise<BenchmarkManifest>
  apply: (action: BenchmarkAction) => void
  hasDetail: (id: string) => boolean
}) {
  const hydration = createDetailHydration({
    reads, read, hasDetail, errorMessage: 'Could not load benchmark',
    apply: (benchmarkId, manifest) => apply({ type: 'update', benchmarkId, manifest }),
    missing: (benchmarkId) => apply({ type: 'detail-missing', benchmarkId }),
  })
  return { ...hydration, observe: (action: BenchmarkAction) => {
    if (action.type === 'update' || action.type === 'removed') hydration.observe({ type: action.type, id: action.benchmarkId })
    if (action.type === 'snapshot') hydration.observe({ type: 'snapshot', ids: action.benchmarks.map((row) => row.benchmarkId), details: action.details })
  } }
}
