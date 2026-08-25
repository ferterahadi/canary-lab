import path from 'path'
import { bridgeStoreEvents } from '../../../../../shared/store-event-bridge'
import type { WorkspaceEventPublisher } from '../../../../../shared/workspace-events'
import type { CoverageJobManifest, CoverageJobIndexEntry, CoverageJobKind } from './types'
import { FileBackedTaskStore, type TaskStoreEvent } from '../../../../../../../../shared/lib/file-backed-task-store'

// File-backed, event-emitting store for coverage background jobs. A thin
// wrapper over the shared FileBackedTaskStore: it owns the coverage-specific
// index shape, single-flight lookup, and reconcile policy; the generic store
// owns the layout (<logs>/coverage-jobs/<id>/job.json + index.json), atomic
// writes, index upsert, events, and crash recovery.

export interface CoverageJobStoreEvent {
  kind: 'changed' | 'removed'
  /** Required for the same reason as `TaskStoreEvent.id`, which is its only
   *  source (see the forward in the constructor). */
  jobId: string
}

export interface CoverageJobStore {
  list(): CoverageJobIndexEntry[]
  get(jobId: string): CoverageJobManifest | null
  /** The currently-running job for a feature+kind, if any (single-flight key). */
  activeFor(feature: string, kind: CoverageJobKind): CoverageJobIndexEntry | null
  save(manifest: CoverageJobManifest): void
  remove(jobId: string): void
  /** Re-home every record from one feature name to another (suite rename). */
  renameFeature(from: string, to: string): number
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
    ...(m.producer ? { producer: m.producer } : {}),
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
      featureOf: (m) => m.feature,
      withFeature: (m, feature) => ({ ...m, feature }),
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

  renameFeature(from: string, to: string): number {
    return this.store.renameFeature(from, to)
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

// One wrapper per logs dir. The wrapper owns the listener set the workspace
// bridge attaches to, and the MCP coverage tools construct a store per tool
// CALL — a fresh wrapper each time would both miss the bridge and pile up
// forwarding listeners on the store underneath.
const SHARED: Map<string, CoverageJobRunStore> = new Map()

export function coverageJobStore(logsDir: string): CoverageJobRunStore {
  const key = path.resolve(logsDir)
  const existing = SHARED.get(key)
  if (existing) return existing
  const created = new CoverageJobRunStore(logsDir)
  SHARED.set(key, created)
  return created
}

// A `resetCoverageJobStores()` used to sit here, described as "for tests". No
// test ever called it: the memo is keyed by resolved logs dir and every suite
// builds a fresh tmpdir, so entries never collide. Kept as an unused export it
// was a permanently uncovered function documenting a need that does not exist —
// `resetSharedTaskStores()` is the real reset, for the store underneath.

/**
 * Attach the workspace bus to a coverage-job store.
 *
 * A coverage job's whole point is that it rewrites the feature's ledger, so the
 * event is `coverage-changed` for the job's feature — the same event its
 * runners used to publish by hand at six sites, one per lifecycle step, which
 * is how a step could be added without one.
 *
 * The FEATURE has to come off the record, so the bridge loads it: a store event
 * carries only the id.
 */
export function bridgeCoverageJobEvents(
  store: CoverageJobRunStore,
  events: WorkspaceEventPublisher | undefined,
): void {
  bridgeStoreEvents(store, events, (e) => {
    // A removed job (pruned history) has no record to read a feature from, and
    // nothing about the ledger changed — stay quiet. The event always names a
    // job, so only the missing RECORD is worth guarding.
    const feature = store.get(e.jobId)?.feature
    return feature ? { type: 'coverage-changed', feature } : null
  })
}
