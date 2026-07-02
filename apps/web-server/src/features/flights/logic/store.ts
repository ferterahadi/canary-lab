import path from 'path'
import type { FlightIndexEntry, FlightManifest, FlightStageKey } from './types'
import { isActiveFlightStatus } from './types'
import { FileBackedTaskStore, type TaskStoreEvent } from '../../../../../../shared/lib/file-backed-task-store'

// File-backed, event-emitting store for First Flight background jobs. A thin
// wrapper over the shared FileBackedTaskStore: it owns the flight-specific
// index shape, the repo-keyed single-flight lookup, and the reconcile policy;
// the generic store owns the layout (<logs>/flights/<id>/flight.json +
// index.json), atomic writes, index upsert, events, and crash recovery.
//
// Reconcile marks a dead process's `running` flight `paused` — NOT `aborted` —
// because flights are resumable by design: the stage array records exactly
// where to pick up, and `fly` on the same repo resumes from the first open
// stage. The mid-flight `running` stage flips back to `pending` so resume
// re-runs it from its own postcondition check.

export interface FlightStoreEvent {
  kind: 'changed' | 'removed'
  flightId?: string
}

export interface FlightStore {
  list(): FlightIndexEntry[]
  get(flightId: string): FlightManifest | null
  /** The active flight whose repo set intersects `repoPaths`, if any (the
   *  single-flight key — two flights must never conduct the same product repo). */
  activeForRepos(repoPaths: string[]): FlightIndexEntry | null
  /** The most recent flight (any status) whose repo set intersects `repoPaths`
   *  — the resume/similarity entry point for a repeated `fly`. */
  latestForRepos(repoPaths: string[]): FlightIndexEntry | null
  save(manifest: FlightManifest): void
  remove(flightId: string): void
  /** Per-flight sidecar dir (agent-session refs, stage artifacts). */
  flightDir(flightId: string): string
  reconcileInterrupted(now: () => string): void
  onEvent(fn: (event: FlightStoreEvent) => void): void
  offEvent(fn: (event: FlightStoreEvent) => void): void
}

function indexEntryFromManifest(m: FlightManifest): FlightIndexEntry {
  return {
    id: m.flightId,
    createdAt: m.createdAt,
    flightId: m.flightId,
    feature: m.feature,
    repoPaths: m.repoPaths,
    status: m.status,
    currentStage: m.currentStage,
    stages: m.stages.map((s) => ({ key: s.key, status: s.status })),
    updatedAt: m.updatedAt,
    ...(m.endedAt ? { endedAt: m.endedAt } : {}),
  }
}

function repoSetsIntersect(a: string[], b: string[]): boolean {
  const norm = (p: string) => path.resolve(p)
  const set = new Set(a.map(norm))
  return b.some((p) => set.has(norm(p)))
}

export class FlightRunStore implements FlightStore {
  private readonly listeners = new Set<(event: FlightStoreEvent) => void>()
  private readonly store: FileBackedTaskStore<FlightManifest>

  constructor(logsDir: string) {
    this.store = new FileBackedTaskStore<FlightManifest>({
      logsDir,
      dirName: 'flights',
      recordFile: 'flight.json',
      idOf: (m) => m.flightId,
      statusOf: (m) => m.status,
      indexEntryOf: indexEntryFromManifest,
      sortNewestFirst: true,
      reconcile: {
        isInterrupted: (m) => m.status === 'running',
        mark: (m, now) => ({
          ...m,
          status: 'paused',
          updatedAt: now,
          stages: m.stages.map((s) =>
            s.status === 'running' ? { ...s, status: 'pending' as const } : s,
          ),
          error: m.error ?? 'Interrupted by server restart — resume with `canary-lab fly`',
        }),
      },
    })
    this.store.onEvent((e: TaskStoreEvent) => this.emit({ kind: e.kind, flightId: e.id }))
  }

  list(): FlightIndexEntry[] {
    return this.store.list() as FlightIndexEntry[]
  }

  get(flightId: string): FlightManifest | null {
    return this.store.get(flightId)
  }

  activeForRepos(repoPaths: string[]): FlightIndexEntry | null {
    return (
      this.list().find(
        (e) => isActiveFlightStatus(e.status) && repoSetsIntersect(e.repoPaths ?? [], repoPaths),
      ) ?? null
    )
  }

  latestForRepos(repoPaths: string[]): FlightIndexEntry | null {
    // list() is newest-first (sortNewestFirst), so the first hit is the latest.
    return this.list().find((e) => repoSetsIntersect(e.repoPaths ?? [], repoPaths)) ?? null
  }

  save(manifest: FlightManifest): void {
    this.store.save(manifest)
  }

  remove(flightId: string): void {
    this.store.remove(flightId)
  }

  flightDir(flightId: string): string {
    return this.store.recordDir(flightId)
  }

  reconcileInterrupted(now: () => string): void {
    this.store.reconcileInterrupted(now)
  }

  onEvent(fn: (event: FlightStoreEvent) => void): void {
    this.listeners.add(fn)
  }

  offEvent(fn: (event: FlightStoreEvent) => void): void {
    this.listeners.delete(fn)
  }

  private emit(event: FlightStoreEvent): void {
    for (const fn of this.listeners) {
      try { fn(event) } catch { /* a bad listener must not break persistence */ }
    }
  }
}

export type { FlightManifest, FlightIndexEntry, FlightStageKey }
