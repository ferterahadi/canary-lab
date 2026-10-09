import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import { EventEmitter } from 'events'
import {
  readManifest,
  readRunsIndex,
  updateManifest,
  upsertRunsIndexEntry,
  writeRunsIndex,
} from './runtime/manifest'
import type { RunHeartbeatOwner, RunManifest } from '../../../../../../shared/run-manifest'
import type { RunIndexEntry } from '../../../../../../shared/run-index'
import { runDirFor, runManifestPath } from './runtime/run-paths'
import { FileRunStateSink, type RunStateSink } from './runtime/run-state-sink'
import {
  createRunLifecycleEvent,
  isActiveRunStatus,
  isUnsettledRunStatus,
  type RunLifecycleEvent,
  type ServiceStatus,
} from '../../../../../../shared/run-state'
import { isProcessAlive } from '../../../../../../shared/runtime/active-servers'
import { judgeRunOwnership, type RunOwnership } from './runtime/run-ownership'
import { trimRunArtifacts } from './run-artifacts'
import {
  AbortAllResult,
  AbortResult,
  DeleteResult,
  TrimResult,
  listCleanupEntries,
  reapStaleRuns,
  removeRunFromHistory,
} from './run-cleanup'
import { CleanupListing } from '../../../../../../shared/cleanup-listing'
import { getRunDetail } from './run-detail'
import { RunDetail } from '../../../../../../shared/run-detail'
import type { OrchestratorRegistry } from './run-registry'
import { cleanupSuiteRuntimeInputsForRun } from './runtime/suite-runtime-inputs'

export interface ListRunsOptions {
  feature?: string
}

// Standalone helper kept for backwards compatibility (existing tests + the
// reapStaleRuns export below). Production code should prefer
// `RunStore.list()`.
export function listRuns(logsDir: string, opts: ListRunsOptions = {}): RunIndexEntry[] {
  const all = readRunsIndex(logsDir)
  const filtered = opts.feature ? all.filter((e) => e.feature === opts.feature) : all
  return [...filtered]
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0))
    .map((entry) => fillIndexProvenance(logsDir, entry))
}

/** The index mirrors repair evidence/provenance from the manifest. Entries
 *  written before any of these fields existed have gaps; the manifest is truth,
 *  so read it only when one is missing. A cleaned run legitimately stays absent.
 *  `env` joined them later, so a run recorded before it existed still shows its
 *  envset rather than silently reading as "no envset". */
function fillIndexProvenance(logsDir: string, entry: RunIndexEntry): RunIndexEntry {
  if (entry.healCycles !== undefined && entry.healMode !== undefined && entry.env !== undefined) return entry
  const manifest = readManifest(runManifestPath(runDirFor(logsDir, entry.runId)))
  if (!manifest) return entry
  return {
    ...entry,
    ...(entry.healCycles === undefined && manifest.healCycles ? { healCycles: manifest.healCycles } : {}),
    ...(entry.healMode === undefined && manifest.healMode ? { healMode: manifest.healMode } : {}),
    ...(entry.env === undefined && manifest.env ? { env: manifest.env } : {}),
  }
}

/**
 * Follow a suite rename into run history. The feature name IS the suite's
 * identity, so it is stamped on both the index row and the run's own manifest —
 * a rename that touches only one of them splits the history in half. Rewrites
 * both, leaves other features alone, and returns how many runs moved.
 * A missing run directory is not an error (a trimmed/cleaned run still has an
 * index row that must follow the name).
 */
export function renameRunFeature(logsDir: string, from: string, to: string): number {
  if (from === to) return 0
  const entries = readRunsIndex(logsDir)
  const matching = entries.filter((e) => e.feature === from)
  if (matching.length === 0) return 0
  writeRunsIndex(
    logsDir,
    entries.map((e) => (e.feature === from ? { ...e, feature: to } : e)),
  )
  for (const entry of matching) {
    const manifestPath = runManifestPath(runDirFor(logsDir, entry.runId))
    if (!fs.existsSync(manifestPath)) continue
    updateManifest(manifestPath, { feature: to })
  }
  return matching.length
}

// ─── RunStore ────────────────────────────────────────────────────────────

export interface RunStoreEvent {
  /** What kind of mutation happened. Subscribers can use this to decide
   *  whether to refetch a single run or the whole list:
   *   - `bootstrap` / `changed` / `finalized` — single-run change, including
   *     reporter-owned summary updates
   *   - `removed` — single-run history removal
   *   - `index-changed` — list-level (e.g. reaper)
   *   - `journal-changed` — per-run diagnosis journal changed
   *   - `external-heal-task` — a run held by an external client just entered
   *     `waiting-for-signal` and the client should fetch heal context.
   *   - `external-claim-changed` — claim / release / heartbeat-stale
   *     transitions for the external session that owns this run. */
  kind:
    | 'bootstrap'
    | 'changed'
    | 'finalized'
    | 'removed'
    | 'index-changed'
    | 'journal-changed'
    | 'external-heal-task'
    | 'external-claim-changed'
  runId?: string
}

export type RunStoreEventListener = (e: RunStoreEvent) => void

export interface RunStoreOptions {
  /** This server's heartbeat signature; tests pin it to stage a peer. */
  owner?: RunHeartbeatOwner
  isProcessAlive?: (pid: number) => boolean
}

/** Why a run nobody drives any more was settled `aborted`, as its last
 *  lifecycle record says it. `server-exited` is the honest account of an
 *  orphan: the process that held its services and heal loop is gone. */
interface OrphanSettlement {
  reason: 'server-exited' | 'run-stopped'
  headline: string
  detail?: string
  /** A boot-only session has no repair to continue, so it says less. */
  bootDetail?: string
}

const SERVER_EXITED: OrphanSettlement = {
  reason: 'server-exited',
  headline: 'Run aborted — its Canary Lab server stopped',
  detail: 'The server driving this run exited before the run finished, and its services and heal loop ended with it. Restart the run to continue repairing.',
  bootDetail: 'The server holding these services exited, and they stopped with it.',
}

const RUN_STOPPED: OrphanSettlement = { reason: 'run-stopped', headline: 'Run aborted' }

/** What an action on a just-settled orphan tells its caller, UI or agent. */
export const SERVER_EXITED_MESSAGE = 'The Canary Lab server driving this run stopped before it finished, so the run is now marked aborted. Restart it to continue repairing.'

/** How often a running server re-checks unsettled rows for a dead owner. */
export const ORPHANED_RUN_SWEEP_MS = 15_000

/**
 * Single owner of `logs/` mutations. Routes and the orchestrator both go
 * through this class — no other code should call `updateManifest` /
 * `upsertRunsIndexEntry` / `removeRunFromHistory` directly. Every mutation
 * emits an `event` so subscribers (the WS endpoint) can push updates without
 * polling.
 *
 * The class is composed of a `FileRunStateSink` (the actual file writes,
 * defined in lib/runtime/) plus an EventEmitter and the operational
 * methods (abort/delete/reapStale) that need access to the orchestrator
 * registry. It satisfies the `RunStateSink` interface so it can be passed
 * directly into the orchestrator constructor.
 */
export class RunStore extends EventEmitter implements RunStateSink {
  private readonly sink: FileRunStateSink
  private readonly isProcessAlive: (pid: number) => boolean

  constructor(
    public readonly logsDir: string,
    public readonly registry: OrchestratorRegistry,
    opts: RunStoreOptions = {},
  ) {
    super()
    this.sink = new FileRunStateSink(logsDir, opts.owner)
    this.isProcessAlive = opts.isProcessAlive ?? isProcessAlive
  }

  /** Typed `on`/`off` for the single `event` channel we publish.
   *  Inheriting `EventEmitter`'s loose `(...args: any[])` signature would
   *  accept the listener but lose the `RunStoreEvent` type at call sites
   *  — these wrappers preserve it. */
  onEvent(listener: RunStoreEventListener): this {
    super.on('event', listener)
    return this
  }

  offEvent(listener: RunStoreEventListener): this {
    super.off('event', listener)
    return this
  }

  // ─── reads ──────────────────────────────────────────────────────────

  list(opts: ListRunsOptions = {}): RunIndexEntry[] {
    return listRuns(this.logsDir, opts)
  }

  get(runId: string): RunDetail | null {
    return getRunDetail(this.logsDir, runId)
  }

  // ─── path helpers ───────────────────────────────────────────────────

  manifestPath(runId: string): string {
    return this.sink.manifestPath(runId)
  }

  // ─── writes (RunStateSink + emit) ───────────────────────────────────

  bootstrap(manifest: RunManifest): void {
    fs.mkdirSync(path.dirname(this.manifestPath(manifest.runId)), { recursive: true })
    this.sink.bootstrap(manifest)
    this.emitEvent({ kind: 'bootstrap', runId: manifest.runId })
  }

  patchManifest(runId: string, patch: Partial<RunManifest>): void {
    this.sink.patchManifest(runId, patch)
    this.emitEvent({ kind: 'changed', runId })
  }

  recordLifecycleEvent(runId: string, event: RunLifecycleEvent): void {
    this.sink.recordLifecycleEvent(runId, event)
    this.emitEvent({ kind: 'changed', runId })
    if (event.phase === 'waiting-for-signal') {
      const detail = this.get(runId)
      if (detail?.manifest.healMode === 'external') {
        this.emitEvent({ kind: 'external-heal-task', runId })
      }
    }
  }

  recordJournalChange(runId: string): void {
    this.emitEvent({ kind: 'journal-changed', runId })
  }

  /** External artifact writers notify subscribers to read the latest detail.
   * This does not mutate the manifest, lifecycle or history index. */
  notifyDetailChanged(runId: string): void {
    this.emitEvent({ kind: 'changed', runId })
  }

  setStatus(runId: string, status: RunManifest['status'], healCycles?: number): void {
    this.sink.setStatus(runId, status, healCycles)
    this.emitEvent({ kind: 'changed', runId })
  }

  finalize(
    runId: string,
    status: RunManifest['status'],
    endedAt: string,
    healCycles: number,
  ): void {
    this.sink.finalize(runId, status, endedAt, healCycles)
    this.emitEvent({ kind: 'finalized', runId })
  }

  setServiceStatus(runId: string, safeName: string, status: ServiceStatus): void {
    this.sink.setServiceStatus(runId, safeName, status)
    this.emitEvent({ kind: 'changed', runId })
  }

  /** Append a heartbeat. Intentionally does NOT emit — heartbeats fire every
   *  5 s and would flood subscribers with no useful information. The next
   *  real status change carries the up-to-date heartbeat anyway. */
  recordHeartbeat(runId: string): void {
    this.sink.recordHeartbeat(runId)
  }

  // ─── operations ─────────────────────────────────────────────────────

  /** Abort an unsettled or orphaned run. Registered orchestrators get the
   *  normal stop path; persisted queued/running/healing rows without a registry
   *  entry are finalized directly so the UI can recover from a dead server
   *  process.
   *
   *  A `queued` row this process still holds in its admission queue must be
   *  cancelled through the scheduler instead — finalizing the manifest alone
   *  would leave the slot in the queue, to be promoted later onto a run that
   *  already reads as aborted. The abort route asks the scheduler first for
   *  exactly that reason. */
  async abort(runId: string): Promise<AbortResult> {
    const orch = this.registry.get(runId)
    if (orch) {
      try { await orch.stop('aborted') } catch { /* best-effort */ }
      this.registry.delete(runId)
      // Test doubles and failed stop paths may not write terminal state. If
      // the persisted row still reads unsettled, finalize it here.
      this.finalizePersistedUnsettledRun(runId, RUN_STOPPED)
      return { ok: true }
    }
    // Stop on a row nobody drives records why it really ended; on a row a live
    // peer still drives it remains the user's recovery lever.
    const settlement = this.ownershipOf(this.get(runId)?.manifest, Date.now()) === 'gone' ? SERVER_EXITED : RUN_STOPPED
    return this.finalizePersistedUnsettledRun(runId, settlement)
      ? { ok: true }
      : { ok: false, reason: 'not-active' }
  }

  /** Abort every active orchestrator, then repair any remaining persisted
   *  queued/running/healing rows. Used by `canary-lab ui` SIGINT/SIGTERM
   *  cleanup and by boot reconcile.
   *
   *  The two loops answer different questions, and only the first one owns a
   *  process. Loop 1 stops the orchestrators THIS process is running — that is
   *  what shutdown needs, and their heartbeats are fresh by definition. Loop 2
   *  repairs rows left behind on disk and spares only a row a live peer still
   *  drives (`judgeRunOwnership`). Without that check, a second server booting
   *  against the same logs dir marked a healing run `aborted` 3s into its
   *  repair cycle — it could not stop the real heal loop (that lived in the
   *  owning process), so the run kept healing for another 51s while every disk
   *  reader, the UI included, was told it had already ended.
   *
   *  A row this server signed is claimable here, unlike in `settleIfOrphaned`:
   *  at boot it is a previous life's, and at shutdown it is a queue slot about
   *  to vanish with the process. */
  async abortAllActiveOrStale(): Promise<AbortAllResult> {
    const aborted = new Set<string>()
    for (const orch of this.registry.list()) {
      // Registered orchestrators are always abortable through `abort()`.
      await this.abort(orch.runId)
      aborted.add(orch.runId)
    }
    const now = Date.now()
    for (const entry of this.list()) {
      if (!isUnsettledRunStatus(entry.status)) continue
      if (this.ownershipOf(this.get(entry.runId)?.manifest, now) === 'other-live-server') continue
      if (this.finalizePersistedUnsettledRun(entry.runId, SERVER_EXITED)) aborted.add(entry.runId)
    }
    return { aborted: [...aborted] }
  }

  /** Settle one persisted unsettled run that no live server drives, so every
   *  action and reader agrees it has ended. Returns true when it settled the
   *  run. Callers run this wherever an action finds no orchestrator: otherwise
   *  Stop Heal 404s, `start_run` reuses a corpse and `signal_run` writes a file
   *  nothing reads.
   *
   *  It acts only on positive evidence of death — a heartbeat gone stale or
   *  signed by an exited server. Rows this server registered, signed (a queued
   *  slot) or that a live peer drives are left alone, and so is a row with no
   *  heartbeat or no readable manifest: those predate the heartbeat, and boot
   *  reconcile and Stop already settle them. */
  settleIfOrphaned(runId: string, nowMs: number = Date.now()): boolean {
    if (this.registry.get(runId)) return false
    const manifest = this.get(runId)?.manifest
    if (!manifest?.heartbeatAt || !isUnsettledRunStatus(manifest.status)) return false
    if (this.ownershipOf(manifest, nowMs) !== 'gone') return false
    return this.finalizePersistedUnsettledRun(runId, SERVER_EXITED)
  }

  /** Settle every orphan in the index. The periodic sweep that catches a peer
   *  server dying, or a pre-owner record going stale, while no one acts on the
   *  run. Reads the index file directly: it runs on a timer. */
  settleOrphanedRuns(nowMs: number = Date.now()): string[] {
    return readRunsIndex(this.logsDir)
      .filter((entry) => isUnsettledRunStatus(entry.status) && this.settleIfOrphaned(entry.runId, nowMs))
      .map((entry) => entry.runId)
  }

  /** Who drives a persisted row, by its heartbeat signature. A manifest with
   *  no `heartbeatAt` predates the field and reads as `gone` — the same
   *  distinction `reapStaleRuns` draws.
   *
   *  A queued row only beats once, at enqueue: the 5s heartbeat timer belongs
   *  to the orchestrator, which a queued run does not have yet. Its signature
   *  still names the server holding the queue slot, so a dead holder is
   *  noticed at once; an unsigned queued row reads as a peer's until stale. */
  private ownershipOf(manifest: RunManifest | undefined, nowMs: number): RunOwnership {
    return judgeRunOwnership(manifest ?? {}, this.sink.owner, nowMs, this.isProcessAlive)
  }

  /** Hard-delete a terminal run from history. Refuses (`reason: 'active'`)
   *  if an orchestrator is still registered, refuses (`reason: 'stale'`) if
   *  the manifest still claims active without a registered orchestrator. */
  delete(runId: string): DeleteResult {
    if (this.registry.get(runId)) return { ok: false, reason: 'active' }
    const detail = this.get(runId)
    if (!detail) {
      // No manifest. If a directory still exists it's an orphan (an
      // interrupted run that never finalized) — safe to reap since it isn't
      // registered and has no active status to honor. `removeRunFromHistory`
      // returns false when neither a dir nor an index entry exists.
      if (removeRunFromHistory(this.logsDir, runId)) {
        this.emitEvent({ kind: 'removed', runId })
        return { ok: true }
      }
      return { ok: false, reason: 'not-found' }
    }
    const status = detail.manifest.status
    if (isActiveRunStatus(status)) {
      return { ok: false, reason: 'stale' }
    }
    removeRunFromHistory(this.logsDir, runId)
    this.emitEvent({ kind: 'removed', runId })
    return { ok: true }
  }

  /** Reclaim disk by deleting a terminal run's Playwright artifact dirs while
   *  keeping the run in history. Same active/stale guards as `delete`. Emits
   *  `changed` so subscribers refresh the (now lighter) run. */
  trimArtifacts(runId: string): TrimResult {
    if (this.registry.get(runId)) return { ok: false, reason: 'active' }
    const detail = this.get(runId)
    if (!detail) return { ok: false, reason: 'not-found' }
    if (isActiveRunStatus(detail.manifest.status)) return { ok: false, reason: 'stale' }
    const freedBytes = trimRunArtifacts(this.logsDir, runId)
    this.emitEvent({ kind: 'changed', runId })
    return { ok: true, freedBytes }
  }

  /** Disk-usage view for the Log Cleanup page. Overlays the live orchestrator
   *  registry on top of persisted status so a run that just started (status
   *  not yet flipped) still reports `active`. */
  cleanupListing(): CleanupListing {
    return listCleanupEntries(
      this.logsDir,
      (runId, status) => Boolean(this.registry.get(runId)) || isActiveRunStatus(status),
    )
  }

  /** Remove a run from history without policy checks. The reaper uses this
   *  on stale entries; production callers should prefer `delete()`. */
  removeFromHistory(runId: string): boolean {
    const ok = removeRunFromHistory(this.logsDir, runId)
    if (ok) this.emitEvent({ kind: 'removed', runId })
    return ok
  }

  /** Boot-time cleanup. Mirrors the standalone `reapStaleRuns` but routes
   *  every write through this store so subscribers see the resulting state
   *  flips. Only emits `index-changed` once at the end (per-run emits would
   *  fire before the WS endpoint is subscribed at boot, so they'd be
   *  invisible anyway). */
  async reapStale(): Promise<void> {
    const before = readRunsIndex(this.logsDir).map((e) => `${e.runId}:${e.status}`).join('|')
    await reapStaleRuns(this.logsDir, this.registry)
    const after = readRunsIndex(this.logsDir).map((e) => `${e.runId}:${e.status}`).join('|')
    if (before !== after) this.emitEvent({ kind: 'index-changed' })
  }

  /** The final lifecycle record a dead runner could not write. Without it the
   *  run reads `aborted` under its last live headline ("Waiting for signal"). */
  private recordSettlement(runId: string, isBoot: boolean, settlement: OrphanSettlement): void {
    this.recordLifecycleEvent(runId, createRunLifecycleEvent('aborted', isBoot ? 'Services stopped' : settlement.headline, {
      id: randomUUID(),
      severity: isBoot ? 'info' : 'warning',
      detail: isBoot ? settlement.bootDetail : settlement.detail,
      ...(isBoot ? {} : { abortReason: { reason: settlement.reason } }),
    }))
  }

  private emitEvent(event: RunStoreEvent): void {
    this.emit('event', event)
  }

  private finalizePersistedUnsettledRun(runId: string, settlement: OrphanSettlement): boolean {
    const detail = this.get(runId)
    if (detail) {
      if (!isUnsettledRunStatus(detail.manifest.status)) return false
      try { cleanupSuiteRuntimeInputsForRun(runDirFor(this.logsDir, runId)) } catch { /* malformed metadata stays inspectable for manual cleanup */ }
      this.finalize(runId, 'aborted', new Date().toISOString(), detail.manifest.healCycles)
      this.recordSettlement(runId, detail.manifest.executionType === 'boot', settlement)
      return true
    }
    // No manifest, but the run may still be listed as unsettled in the index
    // (an interrupted boot run that never finalized). `finalize` writes the
    // index even without a manifest, so we can recover it from the index entry
    // alone — otherwise the UI Stop button would be a silent no-op against a
    // zombie.
    const entry = this.list().find((e) => e.runId === runId)
    if (!entry || !isUnsettledRunStatus(entry.status)) return false
    this.finalize(runId, 'aborted', new Date().toISOString(), 0)
    return true
  }
}
