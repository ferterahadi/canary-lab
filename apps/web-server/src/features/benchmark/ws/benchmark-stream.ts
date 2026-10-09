import { isActiveBenchmarkStatus, type BenchmarkStreamFrame } from '../../../../../../shared/benchmark-index'
import type { FastifyInstance } from 'fastify'
import type { BenchmarkStore, BenchmarkStoreEvent } from '../logic/runtime/store'
import { activeDetails, registerRecordStream } from '../../../shared/ws/record-stream'

// `/ws/benchmark` — push channel for the benchmark window, mirroring
// ws/runs-stream.ts. On connect, sends one `snapshot` frame (index + details
// for active benchmarks). Subsequent BenchmarkStore mutations are forwarded as
// `update` (full manifest) / `removed`. The window keeps its state from these
// frames; HTTP is reserved for one-shot mutations (start).
//
// The socket lifecycle is `registerRecordStream`'s (shared/ws/record-stream.ts,
// tested there); this module only maps store events to frames.

export interface BenchmarkStreamDeps {
  store: BenchmarkStore
}

export async function benchmarkStreamRoutes(
  app: FastifyInstance,
  deps: BenchmarkStreamDeps,
): Promise<void> {
  // A full snapshot: the index, plus details only for active benchmarks
  // (terminal ones load their detail lazily via the first `update`).
  const snapshot = (): BenchmarkStreamFrame => {
    const benchmarks = deps.store.list()
    const details = activeDetails(benchmarks, (entry) => isActiveBenchmarkStatus(entry.status), (entry) => entry.benchmarkId, (id) => deps.store.get(id))
    return { type: 'snapshot', benchmarks, details }
  }

  registerRecordStream<BenchmarkStreamFrame, BenchmarkStoreEvent>(app, {
    path: '/ws/benchmark',
    store: deps.store,
    snapshot,
    frameFor: (event) => {
      if (event.kind === 'removed' && event.benchmarkId) return { type: 'removed', benchmarkId: event.benchmarkId }
      // index-level change with no specific id → re-send a full snapshot
      // (with active details, so the client's detail map isn't wiped).
      if (event.kind === 'index-changed') return snapshot()
      if (!event.benchmarkId) return undefined
      const manifest = deps.store.get(event.benchmarkId)
      return manifest ? { type: 'update', benchmarkId: event.benchmarkId, manifest } : undefined
    },
  })
}
