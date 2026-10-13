import { runIndexEntry, type RunIndexEntry } from '../../../../../../../shared/run-index'
import fs from 'fs'
import {
  updateAllServicesStatus,
  updateManifest,
  updateServiceStatus,
  upsertRunsIndexEntry,
  readRunsIndex,
  writeManifest,
  readManifest,
} from './manifest'
import type { RunHeartbeatOwner, RunManifest } from '../../../../../../../shared/run-manifest'
import { newHeartbeatOwner } from './run-ownership'
import { buildRunPaths, runDirFor, runManifestPath, runSummaryPath } from './run-paths'
import { appendJsonLine } from '../../../../shared/json-lines'
import {
  reduceRunLifecycleSnapshot,
  type RunLifecycleEvent,
  type ServiceStatus,
} from '../../../../../../../shared/run-state'
import { atomicWriteJson } from '../../../../../../../shared/lib/atomic-write'

// `RunStateSink` is the interface the orchestrator uses to persist its own
// state. The default implementation (`FileRunStateSink`) writes the same
// manifest.json + runs-index.json files the rest of the system already reads.
// The web-server layer extends this with event emission so
// WebSocket subscribers can be notified without polling — but the
// orchestrator only needs to know about this minimal interface.
//
// Why an interface and not a direct class import: the orchestrator lives
// under `shared/`, the web-server's `RunStore` (which adds events + the
// registry-backed abort/delete operations) lives under
// `apps/web-server/lib/`. A direct dependency would couple `shared/` to
// `apps/`, which is wrong. The interface is the seam.

export interface RunStateSink {
  /** Initial manifest write at orchestrator construction. Also upserts the
   *  runs-index entry. */
  bootstrap(manifest: RunManifest): void

  /** Mid-run status transition. Mirrors the new status into both manifest
   *  and runs-index so they never disagree. */
  setStatus(runId: string, status: RunManifest['status'], healCycles?: number): void

  /** Terminal write. Flips every service to `stopped`, writes the final
   *  status + endedAt + healCycles, mirrors into the index. */
  finalize(
    runId: string,
    status: RunManifest['status'],
    endedAt: string,
    healCycles: number,
  ): void

  /** Per-service health transition. */
  setServiceStatus(runId: string, safeName: string, status: ServiceStatus): void

  /** Append a heartbeat. Implementations may choose not to emit events for
   *  this — heartbeats fire every 5 s and would flood subscribers. */
  recordHeartbeat(runId: string): void

  /** Generic partial-update escape hatch. Used for fields the typed
   *  helpers above don't cover (`stoppedEarly`, `healCycleHistory`). */
  patchManifest(runId: string, patch: Partial<RunManifest>): void

  /** Structured lifecycle narration for the UI. Appends the event and mirrors
   *  its snapshot fields into the manifest so list/detail views stay aligned. */
  recordLifecycleEvent(runId: string, event: RunLifecycleEvent): void

  /** Notify observers that the per-run diagnosis journal changed. File-backed
   *  sinks have nothing to persist here; event-backed sinks fan this out. */
  recordJournalChange(runId: string): void
}

/** File-backed default. The orchestrator uses this directly when no other
 *  sink is injected (e.g. unit tests and the CLI shim). The web-server's
 *  `RunStore` extends this class to add event emission. */
export class FileRunStateSink implements RunStateSink {
  /** Every heartbeat this sink writes is signed with `owner`, so a server that
   *  restarts can tell its dead predecessor's runs from a live peer's. */
  constructor(
    public readonly logsDir: string,
    public readonly owner: RunHeartbeatOwner = newHeartbeatOwner(),
  ) {}

  manifestPath(runId: string): string {
    return runManifestPath(runDirFor(this.logsDir, runId))
  }

  bootstrap(manifest: RunManifest): void {
    const mp = this.manifestPath(manifest.runId)
    const signed = manifest.heartbeatAt ? { ...manifest, heartbeatOwner: this.owner } : manifest
    writeManifest(mp, signed)
    upsertRunsIndexEntry(this.logsDir, indexEntryFromManifest(signed, signed.status))
  }

  setStatus(runId: string, status: RunManifest['status'], healCycles?: number): void {
    const mp = this.manifestPath(runId)
    const patch: Partial<RunManifest> = { status }
    if (healCycles !== undefined) patch.healCycles = healCycles
    updateManifest(mp, patch)
    const m = readManifest(mp)
    if (m) {
      upsertRunsIndexEntry(this.logsDir, indexEntryFromManifest(m, status))
    }
  }

  finalize(
    runId: string,
    status: RunManifest['status'],
    endedAt: string,
    healCycles: number,
  ): void {
    const mp = this.manifestPath(runId)
    updateAllServicesStatus(mp, 'stopped')
    updateManifest(mp, { status, endedAt, healCycles })
    clearRunningFromSummary(runSummaryPath(runDirFor(this.logsDir, runId)))
    const m = readManifest(mp)
    if (m) {
      upsertRunsIndexEntry(this.logsDir, indexEntryFromManifest(m, status, endedAt))
      return
    }
    // No manifest to read (an interrupted run — e.g. a boot/manual-services
    // session killed mid-teardown — that never persisted or had its manifest
    // cleaned up). `updateManifest` above was a no-op, so the index entry would
    // otherwise stay stuck active forever. Flip the existing index row terminal
    // directly so the run can still be aborted/reaped.
    const existing = readRunsIndex(this.logsDir).find((e) => e.runId === runId)
    if (existing) {
      upsertRunsIndexEntry(this.logsDir, { ...existing, status, endedAt })
    }
  }

  setServiceStatus(runId: string, safeName: string, status: ServiceStatus): void {
    updateServiceStatus(this.manifestPath(runId), safeName, status)
  }

  recordHeartbeat(runId: string): void {
    updateManifest(this.manifestPath(runId), { heartbeatAt: new Date().toISOString(), heartbeatOwner: this.owner })
  }

  patchManifest(runId: string, patch: Partial<RunManifest>): void {
    const mp = this.manifestPath(runId)
    updateManifest(mp, patch)
    // The index mirrors the pending-edit and hint counts (list_runs, the runs
    // column chip, the review's Restore/Adopt). They used to reach it only on
    // the next status write, which during a heal wait is minutes away — a spec
    // edited mid-heal showed on the feature list but not on its run (seen
    // live). Re-derive the entry right here for the two fields that carry them.
    if ('specEdits' in patch || 'integrity' in patch) {
      const m = readManifest(mp)
      // Cleared explicitly: a restore takes the count to nothing, and the
      // index merge would otherwise keep the old number.
      if (m) upsertRunsIndexEntry(this.logsDir, indexEntryFromManifest(m, m.status, m.endedAt), { clear: ['pendingSpecEdits', 'integrityHints'] })
    }
  }

  recordLifecycleEvent(runId: string, event: RunLifecycleEvent): void {
    const runDir = runDirFor(this.logsDir, runId)
    const eventPath = buildRunPaths(runDir).lifecycleEventsPath
    const manifestPath = this.manifestPath(runId)
    const stamped: RunLifecycleEvent = {
      ...event,
      updatedAt: event.updatedAt || new Date().toISOString(),
    }
    appendJsonLine(eventPath, stamped)
    const previous = readManifest(manifestPath)?.lifecycle
    updateManifest(manifestPath, { lifecycle: reduceRunLifecycleSnapshot(previous, stamped) })
  }

  recordJournalChange(_runId: string): void {
    // FileRunStateSink has no subscribers. RunStore overrides this to emit.
  }
}

function indexEntryFromManifest(
  manifest: RunManifest,
  status: RunManifest['status'],
  endedAt?: string,
): RunIndexEntry {
  return runIndexEntry({ ...manifest, status, endedAt })
}

function clearRunningFromSummary(summaryPath: string): void {
  let raw: string
  try {
    raw = fs.readFileSync(summaryPath, 'utf-8')
  } catch {
    return
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return
  }
  if (typeof parsed !== 'object' || parsed === null) return
  if (!('running' in parsed) && !('runningTests' in parsed)) return

  const summary = { ...(parsed as Record<string, unknown>) }
  delete summary.running
  delete summary.runningTests
  atomicWriteJson(summaryPath, summary)
}
