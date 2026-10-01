import {
  benchmarkIndexEntry,
  isActiveBenchmarkStatus,
  type BenchmarkIndexEntry,
} from '../../../../../../../shared/benchmark-index'
import type { BenchmarkManifest } from './types'
import { FileBackedTaskStore, type TaskStoreEvent, TaskListeners, legacyEntryId, abortOnRestart } from '../../../../../../../shared/lib/file-backed-task-store'

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
  /** Re-home every record from one feature name to another (suite rename). */
  renameFeature(from: string, to: string): number
  onEvent(fn: (event: BenchmarkStoreEvent) => void): void
  offEvent(fn: (event: BenchmarkStoreEvent) => void): void
}

function indexEntryFromManifest(m: BenchmarkManifest) {
  return {
    id: m.benchmarkId,
    createdAt: m.startedAt,
    ...benchmarkIndexEntry(m),
  }
}

export class BenchmarkRunStore implements BenchmarkStore {
  private readonly events = new TaskListeners<BenchmarkStoreEvent>()
  private readonly store: FileBackedTaskStore<BenchmarkManifest>

  constructor(logsDir: string) {
    this.store = new FileBackedTaskStore<BenchmarkManifest>({
      logsDir,
      dirName: 'benchmarks',
      recordFile: 'benchmark.json',
      idOf: (m) => m.benchmarkId,
      statusOf: (m) => m.status,
      indexEntryOf: indexEntryFromManifest,
      // Legacy rows (pre-`id` index shape) carry only `benchmarkId`; fall back to
      // it so remove/prune/reconcile can address them (else they resurrect on refresh).
      idOfEntry: legacyEntryId('benchmarkId'),
      featureOf: (m) => m.feature,
      withFeature: (m, feature) => ({ ...m, feature }),
      // A `sabotaging`/`ready`/`running` benchmark in the index belongs to a
      // dead process (its driver was killed on restart) and can never finish.
      reconcile: abortOnRestart((m) => isActiveBenchmarkStatus(m.status)),
    })
    this.store.onEvent((e: TaskStoreEvent) => this.events.emit({ kind: e.kind, benchmarkId: e.id }))
  }

  list(): BenchmarkIndexEntry[] {
    return this.store.rows<BenchmarkIndexEntry>()
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

  renameFeature(from: string, to: string): number {
    return this.store.renameFeature(from, to)
  }

  onEvent(fn: (event: BenchmarkStoreEvent) => void): void {
    this.events.add(fn)
  }

  offEvent(fn: (event: BenchmarkStoreEvent) => void): void {
    this.events.delete(fn)
  }
}
