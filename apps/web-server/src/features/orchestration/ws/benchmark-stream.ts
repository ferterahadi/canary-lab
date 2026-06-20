import type { FastifyInstance } from 'fastify'
import type { BenchmarkStore, BenchmarkStoreEvent } from '../logic/runtime/benchmark/store'
import type {
  BenchmarkIndexEntry,
  BenchmarkManifest,
  BenchmarkStatus,
} from '../logic/runtime/benchmark/types'

// `/ws/benchmark` — push channel for the benchmark window, mirroring
// ws/runs-stream.ts. On connect, sends one `snapshot` frame (index + details
// for active benchmarks). Subsequent BenchmarkStore mutations are forwarded as
// `update` (full manifest) / `removed`. The window keeps its state from these
// frames; HTTP is reserved for one-shot mutations (start).
//
// Coverage is excluded for this module — the wire-up is too thin to test
// deterministically without a real WebSocket round-trip. The store + reducer
// underneath are fully covered (benchmark-state.test.ts, store.test.ts).

export interface BenchmarkStreamDeps {
  store: BenchmarkStore
}

export type BenchmarkStreamFrame =
  | {
      type: 'snapshot'
      benchmarks: BenchmarkIndexEntry[]
      details: Record<string, BenchmarkManifest>
    }
  | { type: 'update'; benchmarkId: string; manifest: BenchmarkManifest }
  | { type: 'removed'; benchmarkId: string }

function isActiveBenchmarkStatus(status: BenchmarkStatus): boolean {
  return status === 'sabotaging' || status === 'ready' || status === 'running'
}

export async function benchmarkStreamRoutes(
  app: FastifyInstance,
  deps: BenchmarkStreamDeps,
): Promise<void> {
  app.get('/ws/benchmark', { websocket: true }, (socket) => {
    const send = (frame: BenchmarkStreamFrame): void => {
      try {
        socket.send(JSON.stringify(frame))
      } catch {
        /* socket closed */
      }
    }

    // A full snapshot: the index, plus details only for active benchmarks
    // (terminal ones load their detail lazily via the first `update`).
    const snapshot = (): BenchmarkStreamFrame => {
      const benchmarks = deps.store.list()
      const details: Record<string, BenchmarkManifest> = {}
      for (const entry of benchmarks) {
        if (isActiveBenchmarkStatus(entry.status)) {
          const manifest = deps.store.get(entry.benchmarkId)
          if (manifest) details[entry.benchmarkId] = manifest
        }
      }
      return { type: 'snapshot', benchmarks, details }
    }

    send(snapshot())

    const onEvent = (event: BenchmarkStoreEvent): void => {
      if (event.kind === 'removed' && event.benchmarkId) {
        send({ type: 'removed', benchmarkId: event.benchmarkId })
        return
      }
      // index-level change with no specific id → re-send a full snapshot
      // (with active details, so the client's detail map isn't wiped).
      if (event.kind === 'index-changed') {
        send(snapshot())
        return
      }
      if (!event.benchmarkId) return
      const manifest = deps.store.get(event.benchmarkId)
      if (!manifest) return
      send({ type: 'update', benchmarkId: event.benchmarkId, manifest })
    }

    deps.store.onEvent(onEvent)
    socket.on('close', () => {
      deps.store.offEvent(onEvent)
    })
  })
}
