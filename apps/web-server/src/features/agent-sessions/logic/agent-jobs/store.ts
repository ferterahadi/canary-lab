import path from 'path'
import { bridgeStoreEvents } from '../../../../shared/store-event-bridge'
import type { WorkspaceEventPublisher } from '../../../../shared/workspace-events'
import { FileBackedTaskStore, type TaskStoreEvent } from '../../../../../../../shared/lib/file-backed-task-store'
import type { AgentJobIndexEntry, AgentJobManifest } from './types'

// File-backed store for spawned-agent records. A thin wrapper over the shared
// FileBackedTaskStore — the tenth, not a tenth shape: the generic store owns the
// layout (<logs>/agent-jobs/<id>/job.json + index.json), atomic writes, index
// upsert, events, rename and crash recovery. This file owns only what is specific
// to agent jobs: the index row, the per-flight lookup, and the reconcile policy.

export interface AgentJobStoreEvent {
  kind: 'changed' | 'removed'
  jobId: string
}

/** Why an interrupted record is a tombstone rather than something to resume: the
 *  child died with the server, so there is nothing to re-attach to. Said in the
 *  record's own words, for a reader who has only this row. */
const ORPHANED_NOTE =
  'The server exited while this agent was running. Shutdown cleanup killed it (or it was orphaned if the server crashed). ' +
  'Nothing here is resumable — the stage re-runs when the flight resumes. Its transcript up to that point is still readable.'

function indexEntryFromManifest(m: AgentJobManifest) {
  return {
    id: m.jobId,
    createdAt: m.startedAt,
    jobId: m.jobId,
    ...(m.flightId ? { flightId: m.flightId } : {}),
    ...(m.feature ? { feature: m.feature } : {}),
    ...(m.stage ? { stage: m.stage } : {}),
    status: m.status,
    startedAt: m.startedAt,
    // `endedAt` is ALWAYS present — as `undefined` when the record has none —
    // because the index upsert is a shallow merge (`{ ...oldRow, ...entry }`): a
    // merge can overwrite a key but never delete one. A stage's job id is stable
    // (`<flightId>:<stage>`), so a re-run REUSES the row, and omitting the cleared
    // key left the previous attempt's `endedAt` stuck on a `running` record —
    // caught live, a re-spawned scout reported as both running and already ended.
    // JSON.stringify drops the explicit undefined on write.
    endedAt: m.endedAt,
  }
}

export class AgentJobRunStore {
  private readonly listeners = new Set<(event: AgentJobStoreEvent) => void>()
  private readonly store: FileBackedTaskStore<AgentJobManifest>

  constructor(logsDir: string) {
    this.store = new FileBackedTaskStore<AgentJobManifest>({
      logsDir,
      dirName: 'agent-jobs',
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
          status: 'orphaned',
          endedAt: m.endedAt ?? now,
          note: m.note ?? ORPHANED_NOTE,
        }),
      },
    })
    this.store.onEvent((e: TaskStoreEvent) => this.emit({ kind: e.kind, jobId: e.id }))
  }

  list(): AgentJobIndexEntry[] {
    // Drop the generic store's bookkeeping mirrors (id/createdAt duplicate
    // jobId/startedAt) so the public shape stays exactly AgentJobIndexEntry.
    return this.store.list().map(({ id: _id, createdAt: _createdAt, ...rest }) =>
      rest as unknown as AgentJobIndexEntry,
    )
  }

  get(jobId: string): AgentJobManifest | null {
    return this.store.get(jobId)
  }

  /** Every record for one flight, newest first. */
  forFlight(flightId: string): AgentJobIndexEntry[] {
    return this.list().filter((e) => e.flightId === flightId)
  }

  /** The still-running records for one flight — what a per-agent stop acts on. */
  liveForFlight(flightId: string): AgentJobIndexEntry[] {
    return this.forFlight(flightId).filter((e) => e.status === 'running')
  }

  save(manifest: AgentJobManifest): void {
    this.store.save(manifest)
  }

  patch(jobId: string, patch: Partial<AgentJobManifest>): AgentJobManifest | null {
    return this.store.patch(jobId, patch)
  }

  remove(jobId: string): void {
    this.store.remove(jobId)
  }

  /** Drop every record belonging to one flight — the flight-delete and R78
   *  restart-wipe paths, which must not leave a stage's agent history behind
   *  after the stage itself was rewound to zero. */
  removeForFlight(flightId: string): number {
    const rows = this.forFlight(flightId)
    for (const row of rows) this.store.remove(row.jobId)
    return rows.length
  }

  renameFeature(from: string, to: string): number {
    return this.store.renameFeature(from, to)
  }

  /** Flip anything left `running` by a dead process to `orphaned`. */
  reconcileInterrupted(now: () => string): void {
    this.store.reconcileInterrupted(now)
  }

  onEvent(fn: (event: AgentJobStoreEvent) => void): void {
    this.listeners.add(fn)
  }

  offEvent(fn: (event: AgentJobStoreEvent) => void): void {
    this.listeners.delete(fn)
  }

  private emit(event: AgentJobStoreEvent): void {
    for (const fn of this.listeners) {
      try { fn(event) } catch { /* a bad listener must not break persistence */ }
    }
  }
}

// One wrapper per logs dir, for the same reason the coverage job store memoizes:
// the wrapper owns the listener set the workspace bridge attaches to, and callers
// construct a store per call site — a fresh wrapper each time would miss the
// bridge and pile up forwarding listeners on the store underneath.
const SHARED: Map<string, AgentJobRunStore> = new Map()

export function agentJobStore(logsDir: string): AgentJobRunStore {
  const key = path.resolve(logsDir)
  const existing = SHARED.get(key)
  if (existing) return existing
  const created = new AgentJobRunStore(logsDir)
  SHARED.set(key, created)
  return created
}

/** Announce every record change to the workspace so a viewer updates live —
 *  the same push the run/portify/coverage stores get. */
export function bridgeAgentJobEvents(
  store: AgentJobRunStore,
  events: WorkspaceEventPublisher | undefined,
): void {
  bridgeStoreEvents(store, events, (e) => ({ type: 'agent-jobs-changed', jobId: e.jobId }))
}
