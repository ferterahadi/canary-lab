import type { BenchmarkManifest, BenchmarkIndexEntry } from './types'
import { FileBackedTaskStore, type TaskStoreEvent } from '../../../../../../../shared/lib/file-backed-task-store'

// File-backed, event-emitting benchmark store (the benchmark analogue of
// RunStore). A thin wrapper over the shared FileBackedTaskStore: it owns the
// benchmark-specific index shape + reconcile policy; the generic store owns the
// layout (<logs>/benchmarks/<id>/benchmark.json + index.json), atomic writes,
// index upsert, events, and crash recovery. `save()` is the WS push point.

// Stateful store interface consumed by the REST routes + WS stream (mirrors
// RunStore). The concrete event-emitting implementation is wired in
// createServer alongside the runner.
export interface BenchmarkStoreEvent {
  kind: 'changed' | 'removed' | 'index-changed'
  benchmarkId?: string
}

export interface BenchmarkStore {
  list(): BenchmarkIndexEntry[]
  get(benchmarkId: string): BenchmarkManifest | null
  /** Persist a manifest and push a `changed` event to WS subscribers. Used by
   *  routes that mutate a benchmark out-of-band (e.g. clearing worktrees). */
  save(manifest: BenchmarkManifest): void
  onEvent(fn: (event: BenchmarkStoreEvent) => void): void
  offEvent(fn: (event: BenchmarkStoreEvent) => void): void
}

function indexEntryFromManifest(m: BenchmarkManifest) {
  return {
    id: m.benchmarkId,
    createdAt: m.startedAt,
    benchmarkId: m.benchmarkId,
    feature: m.feature,
    level: m.level,
    status: m.status,
    startedAt: m.startedAt,
    ...(m.endedAt ? { endedAt: m.endedAt } : {}),
  }
}

export class BenchmarkRunStore implements BenchmarkStore {
  private readonly listeners = new Set<(event: BenchmarkStoreEvent) => void>()
  private readonly store: FileBackedTaskStore<BenchmarkManifest>

  constructor(logsDir: string) {
    this.store = new FileBackedTaskStore<BenchmarkManifest>({
      logsDir,
      dirName: 'benchmarks',
      recordFile: 'benchmark.json',
      idOf: (m) => m.benchmarkId,
      statusOf: (m) => m.status,
      indexEntryOf: indexEntryFromManifest,
      reconcile: {
        // A `sabotaging`/`ready`/`running` benchmark in the index belongs to a
        // dead process (its driver was killed on restart) and can never finish.
        isInterrupted: (m) => m.status === 'sabotaging' || m.status === 'ready' || m.status === 'running',
        mark: (m, now) => ({
          ...m,
          status: 'aborted',
          endedAt: m.endedAt ?? now,
          error: m.error ?? 'Interrupted by server restart',
        }),
      },
    })
    this.store.onEvent((e: TaskStoreEvent) => this.emit({ kind: e.kind, benchmarkId: e.id }))
  }

  list(): BenchmarkIndexEntry[] {
    // Drop the generic store's bookkeeping fields (id/createdAt mirror
    // benchmarkId/startedAt) so the public index shape stays exactly BenchmarkIndexEntry.
    return this.store.list().map(({ id: _id, createdAt: _createdAt, ...rest }) =>
      rest as unknown as BenchmarkIndexEntry,
    )
  }

  get(benchmarkId: string): BenchmarkManifest | null {
    return this.store.get(benchmarkId)
  }

  /** Persist the manifest + index entry, then notify subscribers. */
  save(manifest: BenchmarkManifest): void {
    this.store.save(manifest)
  }

  /**
   * Mark any benchmark left non-terminal by a previous process as `aborted`.
   * Called once at startup so a benchmark belonging to a dead process doesn't
   * resume forever as "running" in the UI. Each flip emits `changed`.
   */
  reconcileInterrupted(now: () => string): void {
    this.store.reconcileInterrupted(now)
  }

  /** Drop a benchmark from the index, delete its dir, and notify subscribers. */
  remove(benchmarkId: string): void {
    this.store.remove(benchmarkId)
  }

  onEvent(fn: (event: BenchmarkStoreEvent) => void): void {
    this.listeners.add(fn)
  }

  offEvent(fn: (event: BenchmarkStoreEvent) => void): void {
    this.listeners.delete(fn)
  }

  private emit(event: BenchmarkStoreEvent): void {
    for (const fn of this.listeners) {
      try {
        fn(event)
      } catch {
        /* a bad listener must not break persistence */
      }
    }
  }
}
