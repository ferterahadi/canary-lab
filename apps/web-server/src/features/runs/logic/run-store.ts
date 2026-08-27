import fs from 'fs'
import path from 'path'
import { EventEmitter } from 'events'
import { readManifest, readRunsIndex, updateManifest, upsertRunsIndexEntry, writeRunsIndex, type RunLifecycleEvent, type RunIndexEntry, type RunManifest, type ServiceStatus } from './runtime/manifest'
import { runDirFor } from './runtime/run-paths'
import { FileRunStateSink, type RunStateSink } from './runtime/run-state-sink'
import { isActiveRunStatus, isStaleHeartbeat } from '../../../../../../shared/run-state'
import { trimRunArtifacts } from './run-artifacts'
import { AbortAllResult, AbortResult, CleanupListing, DeleteResult, TrimResult, listCleanupEntries, reapStaleRuns, removeRunFromHistory } from './run-cleanup'
import { RunDetail, getRunDetail } from './run-detail'
import type { OrchestratorRegistry } from './run-registry'

export { dirSizeBytes, indexPlaywrightArtifacts, runArtifactBytes, trimRunArtifacts } from './run-artifacts'
export type { PlaywrightArtifact, PlaywrightArtifactGroup, PlaywrightArtifactKind } from './run-artifacts'
export { listCleanupEntries, reapStaleRuns, removeRunFromHistory } from './run-cleanup'
export type { AbortAllResult, AbortResult, CleanupListing, CleanupOrphan, CleanupRunEntry, DeleteResult, TrimResult } from './run-cleanup'
export { getRunDetail, readPlaywrightPlaybackEvents, readRunLifecycleEvents, readRunSummary } from './run-detail'
export type { PlaywrightPlaybackEvent, RunDetail, RunSummary, RunSummaryFailedEntry, RunSummaryRunningStep } from './run-detail'
export { createRegistry } from './run-registry'
export type { OrchestratorCancelHealResult, OrchestratorInterjectResult, OrchestratorLike, OrchestratorPauseResult, OrchestratorRegistry, RestartHealResult, RestartRunResult, StartRunOutcome } from './run-registry'

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
 *  written before either field existed have gaps; the manifest is truth, so
 *  read it only when one is missing. A cleaned run legitimately stays absent. */
function fillIndexProvenance(logsDir: string, entry: RunIndexEntry): RunIndexEntry {
  if (entry.healCycles !== undefined && entry.healMode !== undefined) return entry
  const manifest = readManifest(path.join(runDirFor(logsDir, entry.runId), 'manifest.json'))
  if (!manifest) return entry
  return {
    ...entry,
    ...(entry.healCycles === undefined && manifest.healCycles ? { healCycles: manifest.healCycles } : {}),
    ...(entry.healMode === undefined && manifest.healMode ? { healMode: manifest.healMode } : {}),
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
    const manifestPath = path.join(runDirFor(logsDir, entry.runId), 'manifest.json')
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

  constructor(
    public readonly logsDir: string,
    public readonly registry: OrchestratorRegistry,
  ) {
    super()
    this.sink = new FileRunStateSink(logsDir)
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

  /** The Playwright reporter owns e2e-summary.json because it runs in a child
   *  process. Its directory watcher calls this after an atomic summary write
   *  so run-detail subscribers can read and push the new step immediately. */
  notifySummaryChanged(runId: string): void {
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

  /** Abort an active or orphaned-active run. Registered orchestrators get the
   *  normal stop path; persisted running/healing rows without a registry entry
   *  are finalized directly so the UI can recover from a dead server process. */
  async abort(runId: string): Promise<AbortResult> {
    const orch = this.registry.get(runId)
    if (orch) {
      try { await orch.stop('aborted') } catch { /* best-effort */ }
      this.registry.delete(runId)
      // Test doubles and failed stop paths may not write terminal state. If
      // the persisted row still claims active, finalize it here.
      this.finalizePersistedActiveRun(runId)
      return { ok: true }
    }
    return this.finalizePersistedActiveRun(runId)
      ? { ok: true }
      : { ok: false, reason: 'not-active' }
  }

  /** Abort every active orchestrator, then repair any remaining persisted
   *  running/healing rows. Used by `canary-lab ui` SIGINT/SIGTERM cleanup and
   *  by boot reconcile.
   *
   *  The two loops answer different questions, and only the first one owns a
   *  process. Loop 1 stops the orchestrators THIS process is running — that is
   *  what shutdown needs, and their heartbeats are fresh by definition. Loop 2
   *  repairs rows left behind on disk, which is a guess about a process we
   *  cannot see, so it defers to the heartbeat: a row beating within
   *  `HEARTBEAT_STALE_MS` belongs to a live server and is not ours to
   *  finalize. Without that check, a second server booting against the same
   *  logs dir marked a healing run `aborted` 3s into its repair cycle — it
   *  could not stop the real heal loop (that lived in the owning process), so
   *  the run kept healing for another 51s while every disk reader, the UI
   *  included, was told it had already ended. */
  async abortAllActiveOrStale(): Promise<AbortAllResult> {
    const aborted = new Set<string>()
    for (const orch of this.registry.list()) {
      // Registered orchestrators are always abortable through `abort()`.
      await this.abort(orch.runId)
      aborted.add(orch.runId)
    }
    const now = Date.now()
    for (const entry of this.list()) {
      if (!isActiveRunStatus(entry.status)) continue
      if (this.isOwnedByLiveProcess(entry.runId, now)) continue
      const result = await this.abort(entry.runId)
      if (result.ok) aborted.add(entry.runId)
    }
    return { aborted: [...aborted] }
  }

  /** True when a persisted active row is beating fast enough that some other
   *  live process must own it. A manifest with no `heartbeatAt` at all predates
   *  the field and carries no such evidence, so it stays claimable — the same
   *  distinction `reapStaleRuns` draws. */
  private isOwnedByLiveProcess(runId: string, nowMs: number): boolean {
    const heartbeatAt = this.get(runId)?.manifest.heartbeatAt
    if (!heartbeatAt) return false
    return !isStaleHeartbeat(heartbeatAt, nowMs)
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

  private emitEvent(event: RunStoreEvent): void {
    this.emit('event', event)
  }

  private finalizePersistedActiveRun(runId: string): boolean {
    const detail = this.get(runId)
    if (detail) {
      if (!isActiveRunStatus(detail.manifest.status)) return false
      this.finalize(runId, 'aborted', new Date().toISOString(), detail.manifest.healCycles)
      return true
    }
    // No manifest, but the run may still be listed as active in the index (an
    // interrupted boot run that never finalized). `finalize` writes the index
    // even without a manifest, so we can recover it from the index entry alone
    // — otherwise the UI Stop button would be a silent no-op against a zombie.
    const entry = this.list().find((e) => e.runId === runId)
    if (!entry || !isActiveRunStatus(entry.status)) return false
    this.finalize(runId, 'aborted', new Date().toISOString(), 0)
    return true
  }
}

// Re-export the manifest types most callers will want alongside RunStore so
// they don't need a second import.
export type { RunIndexEntry, RunManifest, ServiceManifestEntry } from './runtime/manifest'
