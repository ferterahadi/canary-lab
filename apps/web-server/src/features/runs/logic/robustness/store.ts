import path from 'path'
import { bridgeStoreEvents } from '../../../../shared/store-event-bridge'
import type { WorkspaceEventPublisher } from '../../../../shared/workspace-events'
import { FileBackedTaskStore, type TaskStoreEvent } from '../../../../../../../shared/lib/file-backed-task-store'
import type { RobustnessJobIndexEntry, RobustnessJobManifest } from '../../../../../../../shared/robustness/jobs'

// File-backed store for Robustness Lab jobs — the coverage job store's shape
// over the shared FileBackedTaskStore: the generic store owns the layout
// (<logs>/robustness-jobs/<id>/job.json + index.json), atomic writes, index
// upsert, events, rename and crash recovery. This file owns what is specific
// to robustness jobs: the index row, the single-flight lookup, and the
// reconcile policy (a job left `running` by a dead process is `aborted` — its
// in-memory driver died with the server, so nothing here is resumable).

export interface RobustnessJobStoreEvent {
  kind: 'changed' | 'removed'
  jobId: string
}

function indexEntryFromManifest(m: RobustnessJobManifest) {
  return {
    id: m.jobId,
    createdAt: m.startedAt,
    jobId: m.jobId,
    feature: m.feature,
    runId: m.runId,
    status: m.status,
    startedAt: m.startedAt,
    // Always present (as `undefined` when the record has none): the index upsert
    // is a shallow merge, which can overwrite a key but never delete one.
    endedAt: m.endedAt,
    findings: m.findings.length,
  }
}

export class RobustnessJobRunStore {
  private readonly listeners = new Set<(event: RobustnessJobStoreEvent) => void>()
  private readonly store: FileBackedTaskStore<RobustnessJobManifest>

  constructor(logsDir: string) {
    this.store = new FileBackedTaskStore<RobustnessJobManifest>({
      logsDir,
      dirName: 'robustness-jobs',
      recordFile: 'job.json',
      idOf: (m) => m.jobId,
      indexEntryOf: indexEntryFromManifest,
      featureOf: (m) => m.feature,
      withFeature: (m, feature) => ({ ...m, feature }),
      sortNewestFirst: true,
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

  list(): RobustnessJobIndexEntry[] {
    // Drop the generic store's bookkeeping mirrors (id/createdAt duplicate
    // jobId/startedAt) so the public shape stays exactly RobustnessJobIndexEntry.
    return this.store.list().map(({ id: _id, createdAt: _createdAt, ...rest }) =>
      rest as unknown as RobustnessJobIndexEntry,
    )
  }

  /** Every record for one suite, newest first. */
  forFeature(feature: string): RobustnessJobIndexEntry[] {
    return this.list().filter((e) => e.feature === feature)
  }

  get(jobId: string): RobustnessJobManifest | null {
    return this.store.get(jobId)
  }

  /** The running job for a suite, if any — the single-flight key. One matrix
   *  per suite at a time: two would boot the same services on the same ports. */
  activeFor(feature: string): RobustnessJobIndexEntry | null {
    return this.forFeature(feature).find((e) => e.status === 'running') ?? null
  }

  save(manifest: RobustnessJobManifest): void {
    this.store.save(manifest)
  }

  remove(jobId: string): void {
    this.store.remove(jobId)
  }

  renameFeature(from: string, to: string): number {
    return this.store.renameFeature(from, to)
  }

  /** Flip any job left `running` by a dead process to `aborted`, freeing the
   *  single-flight lock so the user can start a fresh one. */
  reconcileInterrupted(now: () => string): void {
    this.store.reconcileInterrupted(now)
  }

  onEvent(fn: (event: RobustnessJobStoreEvent) => void): void {
    this.listeners.add(fn)
  }

  offEvent(fn: (event: RobustnessJobStoreEvent) => void): void {
    this.listeners.delete(fn)
  }

  private emit(event: RobustnessJobStoreEvent): void {
    for (const fn of this.listeners) {
      try { fn(event) } catch { /* a bad listener must not break persistence */ }
    }
  }
}

// One wrapper per logs dir, for the same reason the coverage and agent-job
// stores memoize: the wrapper owns the listener set the workspace bridge
// attaches to, and the MCP tools construct a store per call — a fresh wrapper
// each time would miss the bridge and pile up forwarding listeners underneath.
const SHARED: Map<string, RobustnessJobRunStore> = new Map()

export function robustnessJobStore(logsDir: string): RobustnessJobRunStore {
  const key = path.resolve(logsDir)
  const existing = SHARED.get(key)
  if (existing) return existing
  const created = new RobustnessJobRunStore(logsDir)
  SHARED.set(key, created)
  return created
}

/** Announce every write as `robustness-changed` for the job's suite, so the
 *  stage pane and the flights pill update live. The FEATURE has to come off the
 *  record, so the bridge loads it; a removed job (pruned history) has no record
 *  and nothing about the suite's findings changed — stay quiet. */
export function bridgeRobustnessJobEvents(
  store: RobustnessJobRunStore,
  events: WorkspaceEventPublisher | undefined,
): void {
  bridgeStoreEvents(store, events, (e) => {
    const feature = store.get(e.jobId)?.feature
    return feature ? { type: 'robustness-changed', feature } : null
  })
}
