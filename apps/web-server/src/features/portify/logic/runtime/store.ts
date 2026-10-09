import {
  portifyIndexEntry,
  isActionablePortifyStatus,
  type PortifyIndexEntry,
  type PortifyManifest,
} from '../../../../../../../shared/portify-index'
import { FileBackedTaskStore, type TaskStoreEvent, TaskListeners, legacyEntryId, abortOnRestart } from '../../../../../../../shared/lib/file-backed-task-store'
import { PORTIFY_DIR_NAME } from './paths'

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
  /** Re-home every record from one feature name to another (suite rename). */
  renameFeature(from: string, to: string): number
  onEvent(fn: (event: PortifyStoreEvent) => void): void
  offEvent(fn: (event: PortifyStoreEvent) => void): void
}

function indexEntryFromManifest(m: PortifyManifest) {
  return {
    id: m.workflowId,
    createdAt: m.startedAt,
    ...portifyIndexEntry(m),
  }
}

export class PortifyRunStore implements PortifyStore {
  private readonly events = new TaskListeners<PortifyStoreEvent>()
  private readonly store: FileBackedTaskStore<PortifyManifest>

  constructor(logsDir: string) {
    this.store = new FileBackedTaskStore<PortifyManifest>({
      logsDir,
      dirName: PORTIFY_DIR_NAME,
      recordFile: 'portify.json',
      idOf: (m) => m.workflowId,
      statusOf: (m) => m.status,
      indexEntryOf: indexEntryFromManifest,
      // Legacy rows (pre-`id` index shape) carry only `workflowId`; fall back to
      // it so they stay addressable for remove/prune/reconcile — otherwise such
      // a row can't be deleted and resurrects on refresh.
      idOfEntry: legacyEntryId('workflowId'),
      featureOf: (m) => m.feature,
      withFeature: (m, feature) => ({ ...m, feature }),
      // 'ready-to-save' is also non-terminal but awaits a user action; a dead
      // process can't hold that scratch worktree, so it too becomes aborted.
      reconcile: abortOnRestart((m) => isActionablePortifyStatus(m.status)),
    })
    this.store.onEvent((e: TaskStoreEvent) => this.events.emit({ kind: e.kind, workflowId: e.id }))
  }

  list(): PortifyIndexEntry[] {
    return this.store.rows<PortifyIndexEntry>()
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

  renameFeature(from: string, to: string): number {
    return this.store.renameFeature(from, to)
  }

  /**
   * Drop "zombie" history rows: index entries whose `portify.json` was wiped
   * out-of-band (a logs cleanup, a manual rm) without going through `remove()`.
   * Such a row lists in history but 404s on open (wizard hangs on "Loading…")
   * and on remove. Emits `removed` for each so live clients prune it. Run on
   * boot, alongside reconcileInterrupted.
   */
  pruneOrphans(): string[] {
    return this.store.pruneOrphans()
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
    this.events.add(fn)
  }

  offEvent(fn: (event: PortifyStoreEvent) => void): void {
    this.events.delete(fn)
  }
}
