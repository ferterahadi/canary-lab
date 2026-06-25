import type { CoverageJobManifest, CoverageJobIndexEntry, CoverageJobKind } from './types'
import { FileBackedTaskStore, type TaskStoreEvent } from '../../../../../../../../shared/lib/file-backed-task-store'

// File-backed, event-emitting store for coverage background jobs. A thin
// wrapper over the shared FileBackedTaskStore: it owns the coverage-specific
// index shape, single-flight lookup, and reconcile policy; the generic store
// owns the layout (<logs>/coverage-jobs/<id>/job.json + index.json), atomic
// writes, index upsert, events, and crash recovery.

export interface CoverageJobStoreEvent {
  kind: 'changed' | 'removed'
  jobId?: string
}

export interface CoverageJobStore {
  list(): CoverageJobIndexEntry[]
  get(jobId: string): CoverageJobManifest | null
  /** The currently-running job for a feature+kind, if any (single-flight key). */
  activeFor(feature: string, kind: CoverageJobKind): CoverageJobIndexEntry | null
  save(manifest: CoverageJobManifest): void
  remove(jobId: string): void
  reconcileInterrupted(now: () => string): void
  onEvent(fn: (event: CoverageJobStoreEvent) => void): void
  offEvent(fn: (event: CoverageJobStoreEvent) => void): void
}

function indexEntryFromManifest(m: CoverageJobManifest) {
  return {
    id: m.jobId,
    createdAt: m.startedAt,
    jobId: m.jobId,
    feature: m.feature,
    kind: m.kind,
    status: m.status,
    startedAt: m.startedAt,
    ...(m.endedAt ? { endedAt: m.endedAt } : {}),
  }
}

export class CoverageJobRunStore implements CoverageJobStore {
  private readonly listeners = new Set<(event: CoverageJobStoreEvent) => void>()
  private readonly store: FileBackedTaskStore<CoverageJobManifest>

  constructor(logsDir: string) {
    this.store = new FileBackedTaskStore<CoverageJobManifest>({
      logsDir,
      dirName: 'coverage-jobs',
      recordFile: 'job.json',
      idOf: (m) => m.jobId,
      statusOf: (m) => m.status,
      indexEntryOf: indexEntryFromManifest,
      // Legacy rows (pre-`id` index shape) carry only `jobId`; fall back to it so
      // remove/prune/reconcile can address them (else they resurrect on refresh).
      idOfEntry: (e) => (typeof e.id === 'string' ? e.id : (e as { jobId?: string }).jobId),
      reconcile: {
        isInterrupted: (m) => m.status === 'running',
        mark: (m, now) => ({
          ...m,
          status: 'aborted',
          endedAt: m.endedAt ?? now,
          error: m.error ?? 'Interrupted by server restart',
        }),
      },
    })
    this.store.onEvent((e: TaskStoreEvent) => this.emit({ kind: e.kind, jobId: e.id }))
  }

  list(): CoverageJobIndexEntry[] {
    // Drop the generic store's bookkeeping fields (id/createdAt mirror
    // jobId/startedAt) so the public index shape stays exactly CoverageJobIndexEntry.
    return this.store.list().map(({ id: _id, createdAt: _createdAt, ...rest }) =>
      rest as unknown as CoverageJobIndexEntry,
    )
  }

  get(jobId: string): CoverageJobManifest | null {
    return this.store.get(jobId)
  }

  activeFor(feature: string, kind: CoverageJobKind): CoverageJobIndexEntry | null {
    return this.list().find(
      (e) => e.feature === feature && e.kind === kind && e.status === 'running',
    ) ?? null
  }

  save(manifest: CoverageJobManifest): void {
    this.store.save(manifest)
  }

  remove(jobId: string): void {
    this.store.remove(jobId)
  }

  /** Flip any job left `running` by a dead process to `aborted` — its in-memory
   *  driver was killed on restart, so it can never finish. Frees the single-
   *  flight lock so the user can start a fresh job. */
  reconcileInterrupted(now: () => string): void {
    this.store.reconcileInterrupted(now)
  }

  onEvent(fn: (event: CoverageJobStoreEvent) => void): void {
    this.listeners.add(fn)
  }

  offEvent(fn: (event: CoverageJobStoreEvent) => void): void {
    this.listeners.delete(fn)
  }

  private emit(event: CoverageJobStoreEvent): void {
    for (const fn of this.listeners) {
      try { fn(event) } catch { /* a bad listener must not break persistence */ }
    }
  }
}
