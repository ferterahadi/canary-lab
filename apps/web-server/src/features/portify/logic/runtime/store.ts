import type { PortifyManifest, PortifyIndexEntry } from './types'
import { FileBackedTaskStore, type TaskStoreEvent } from '../../../../../../../shared/lib/file-backed-task-store'

// File-backed, event-emitting store for port-ification workflows. A thin
// wrapper over the shared FileBackedTaskStore: it owns the portify-specific
// index shape + reconcile policy; the generic store owns the layout, atomic
// writes, index upsert, events, and crash recovery. Record file name +
// directory match `buildPortifyPaths`/`portifyDir` so sidecar files (agent.log,
// verify/, original-config.snapshot) still live alongside the record.

export interface PortifyStoreEvent {
  kind: 'changed' | 'removed'
  workflowId?: string
}

export interface PortifyStore {
  list(): PortifyIndexEntry[]
  get(workflowId: string): PortifyManifest | null
  save(manifest: PortifyManifest): void
  remove(workflowId: string): void
  onEvent(fn: (event: PortifyStoreEvent) => void): void
  offEvent(fn: (event: PortifyStoreEvent) => void): void
}

function indexEntryFromManifest(m: PortifyManifest) {
  return {
    id: m.workflowId,
    createdAt: m.startedAt,
    workflowId: m.workflowId,
    feature: m.feature,
    status: m.status,
    branch: m.branch,
    startedAt: m.startedAt,
    ...(m.endedAt ? { endedAt: m.endedAt } : {}),
  }
}

export class PortifyRunStore implements PortifyStore {
  private readonly listeners = new Set<(event: PortifyStoreEvent) => void>()
  private readonly store: FileBackedTaskStore<PortifyManifest>

  constructor(logsDir: string) {
    this.store = new FileBackedTaskStore<PortifyManifest>({
      logsDir,
      dirName: 'portify',
      recordFile: 'portify.json',
      idOf: (m) => m.workflowId,
      statusOf: (m) => m.status,
      indexEntryOf: indexEntryFromManifest,
      reconcile: {
        // 'ready-to-save' is also non-terminal but awaits a user action; a dead
        // process can't hold that scratch worktree, so it too becomes aborted.
        isInterrupted: (m) => m.status !== 'saved' && m.status !== 'failed' && m.status !== 'aborted',
        mark: (m, now) => ({
          ...m,
          status: 'aborted',
          endedAt: m.endedAt ?? now,
          error: m.error ?? 'Interrupted by server restart',
        }),
      },
    })
    this.store.onEvent((e: TaskStoreEvent) => this.emit({ kind: e.kind, workflowId: e.id }))
  }

  list(): PortifyIndexEntry[] {
    // Drop the generic store's bookkeeping fields (id/createdAt mirror
    // workflowId/startedAt) so the public index shape stays exactly PortifyIndexEntry.
    return this.store.list().map(({ id: _id, createdAt: _createdAt, ...rest }) =>
      rest as unknown as PortifyIndexEntry,
    )
  }

  get(workflowId: string): PortifyManifest | null {
    return this.store.get(workflowId)
  }

  save(manifest: PortifyManifest): void {
    this.store.save(manifest)
  }

  /**
   * Drop a workflow from history: remove its index entry and run directory,
   * then emit `removed` so live clients prune it. Does NOT touch any git branch
   * a committed workflow landed — that's the user's work in their own repo.
   * No-op (still emits) if the entry is already gone.
   */
  remove(workflowId: string): void {
    this.store.remove(workflowId)
  }

  /**
   * Flip any workflow left in a non-terminal state by a dead process to
   * `aborted`. Its in-memory driver was killed on restart, so it can never
   * finish — flip it so the UI doesn't show it as live forever. (Orphaned
   * worktrees + branches are reclaimed separately via the worktree inventory.)
   */
  reconcileInterrupted(now: () => string): void {
    this.store.reconcileInterrupted(now)
  }

  onEvent(fn: (event: PortifyStoreEvent) => void): void {
    this.listeners.add(fn)
  }

  offEvent(fn: (event: PortifyStoreEvent) => void): void {
    this.listeners.delete(fn)
  }

  private emit(event: PortifyStoreEvent): void {
    for (const fn of this.listeners) {
      try { fn(event) } catch { /* a bad listener must not break persistence */ }
    }
  }
}
