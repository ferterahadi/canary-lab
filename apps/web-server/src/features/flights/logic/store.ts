import path from 'path'
import type { FlightIndexEntry, FlightManifest, FlightStageKey } from './types'
import { isActiveFlightStatus, isTerminalFlightStatus } from './types'
import { FileBackedTaskStore, type TaskStoreEvent } from '../../../../../../shared/lib/file-backed-task-store'

// File-backed, event-emitting store for Flight background jobs. A thin
// wrapper over the shared FileBackedTaskStore: it owns the flight-specific
// index shape, the repo-keyed single-flight lookup, and the reconcile policy;
// the generic store owns the layout (<logs>/flights/<id>/flight.json +
// index.json), atomic writes, index upsert, events, and crash recovery.
//
// Reconcile marks a dead process's `running` flight `paused` — NOT `aborted` —
// because flights are resumable by design: the stage array records exactly
// where to pick up, and `flight` on the same repo resumes from the first open
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
   *  — the resume/similarity entry point for a repeated `flight`. */
  latestForRepos(repoPaths: string[]): FlightIndexEntry | null
  /** The feature's flight record, if any. A feature has at most one flight —
   *  the conductor continues/redoes/jumps this record instead of minting a
   *  second manifest (newest-first fallback covers pre-invariant history). */
  latestForFeature(feature: string): FlightIndexEntry | null
  save(manifest: FlightManifest): void
  remove(flightId: string): void
  /** Re-home every record from one feature name to another (suite rename). */
  renameFeature(from: string, to: string): number
  /** Per-flight sidecar dir (agent-session refs, stage artifacts). */
  flightDir(flightId: string): string
  reconcileInterrupted(now: () => string): void
  onEvent(fn: (event: FlightStoreEvent) => void): void
  offEvent(fn: (event: FlightStoreEvent) => void): void
}

function indexEntryFromManifest(m: FlightManifest): FlightIndexEntry {
  // Clearable keys (group / pauseReason / endedAt) are ALWAYS present — as
  // `undefined` when the manifest has none — because the index upsert is a
  // shallow merge (`{ ...oldRow, ...entry }`): a merge can overwrite a key but
  // never delete one, so omitting a cleared key would leave the previous
  // value stuck on the row forever (a resumed flight showing `running` WITH
  // its old `pauseReason: "stage-failed"`). An explicit `undefined` overrides
  // the stale value in the merge, and JSON.stringify drops the key on write.
  return {
    id: m.flightId,
    createdAt: m.createdAt,
    flightId: m.flightId,
    feature: m.feature,
    repoPaths: m.repoPaths,
    group: m.opts.group,
    status: m.status,
    pauseReason: m.pauseReason,
    currentStage: m.currentStage,
    stages: m.stages.map((s) => ({ key: s.key, status: s.status })),
    updatedAt: m.updatedAt,
    endedAt: m.endedAt,
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
      indexEntryOf: indexEntryFromManifest,
      featureOf: (m) => m.feature,
      withFeature: (m, feature) => ({ ...m, feature }),
      sortNewestFirst: true,
      reconcile: {
        isInterrupted: (m) => m.status === 'running',
        mark: (m, now) => ({
          ...m,
          status: 'paused',
          pauseReason: 'restart' as const,
          updatedAt: now,
          stages: m.stages.map((s) =>
            s.status === 'running' ? { ...s, status: 'pending' as const } : s,
          ),
          error: m.error ?? 'Interrupted by server restart — resume with `canary-lab flight`',
        }),
      },
    })
    this.repairLegacyTerminalStages()
    this.store.onEvent((e: TaskStoreEvent) => this.emit({ kind: e.kind, flightId: e.id }))
  }

  /** Older aborts only settled the flight, leaving the interrupted stage live.
   *  Repair those persisted records at open so a terminal flight cannot render
   *  a blue "running" stage or retain an answerable checkpoint. */
  private repairLegacyTerminalStages(): void {
    for (const entry of this.store.list()) {
      const manifest = this.store.get(entry.id)
      if (!manifest || !isTerminalFlightStatus(manifest.status)) continue
      let repaired = false
      const stages = manifest.stages.map((stage) => {
        if (stage.status !== 'running' && stage.status !== 'waiting-for-approval') return stage
        repaired = true
        return { ...stage, status: 'pending' as const, checkpoint: undefined }
      })
      if (repaired) this.store.save({ ...manifest, stages })
    }
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

  latestForFeature(feature: string): FlightIndexEntry | null {
    return this.list().find((e) => e.feature === feature) ?? null
  }

  save(manifest: FlightManifest): void {
    this.store.save(manifest)
  }

  remove(flightId: string): void {
    this.store.remove(flightId)
  }

  renameFeature(from: string, to: string): number {
    return this.store.renameFeature(from, to)
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
