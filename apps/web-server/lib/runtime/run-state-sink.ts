import fs from 'fs'
import path from 'path'
import {
  setCurrentRunSymlink,
  updateAllServicesStatus,
  updateManifest,
  updateServiceStatus,
  upsertRunsIndexEntry,
  writeManifest,
  readManifest,
  type RunLifecycleEvent,
  type RunIndexEntry,
  type RunManifest,
  type ServiceStatus,
} from './manifest'
import { buildRunPaths, runDirFor } from './run-paths'
import { reduceRunLifecycleSnapshot } from '../../../../shared/run-state'

// `RunStateSink` is the interface the orchestrator uses to persist its own
// state. The default implementation (`FileRunStateSink`) writes the same
// manifest.json + runs-index.json + symlink files the rest of the system
// already reads. The web-server layer extends this with event emission so
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
   *  runs-index entry and points `logs/current` at this run. */
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
}

/** File-backed default. The orchestrator uses this directly when no other
 *  sink is injected (e.g. unit tests and the CLI shim). The web-server's
 *  `RunStore` extends this class to add event emission. */
export class FileRunStateSink implements RunStateSink {
  constructor(public readonly logsDir: string) {}

  manifestPath(runId: string): string {
    return path.join(runDirFor(this.logsDir, runId), 'manifest.json')
  }

  bootstrap(manifest: RunManifest): void {
    const mp = this.manifestPath(manifest.runId)
    writeManifest(mp, manifest)
    upsertRunsIndexEntry(this.logsDir, indexEntryFromManifest(manifest, manifest.status))
    setCurrentRunSymlink(this.logsDir, manifest.runId)
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
    clearRunningFromSummary(path.join(runDirFor(this.logsDir, runId), 'e2e-summary.json'))
    const m = readManifest(mp)
    if (m) {
      upsertRunsIndexEntry(this.logsDir, indexEntryFromManifest(m, status, endedAt))
    }
  }

  setServiceStatus(runId: string, safeName: string, status: ServiceStatus): void {
    updateServiceStatus(this.manifestPath(runId), safeName, status)
  }

  recordHeartbeat(runId: string): void {
    updateManifest(this.manifestPath(runId), { heartbeatAt: new Date().toISOString() })
  }

  patchManifest(runId: string, patch: Partial<RunManifest>): void {
    updateManifest(this.manifestPath(runId), patch)
  }

  recordLifecycleEvent(runId: string, event: RunLifecycleEvent): void {
    const runDir = runDirFor(this.logsDir, runId)
    const eventPath = buildRunPaths(runDir).lifecycleEventsPath
    const manifestPath = this.manifestPath(runId)
    const stamped: RunLifecycleEvent = {
      ...event,
      updatedAt: event.updatedAt || new Date().toISOString(),
    }
    fs.mkdirSync(path.dirname(eventPath), { recursive: true })
    fs.appendFileSync(eventPath, JSON.stringify(stamped) + '\n')
    const previous = readManifest(manifestPath)?.lifecycle
    updateManifest(manifestPath, { lifecycle: reduceRunLifecycleSnapshot(previous, stamped) })
  }
}

function indexEntryFromManifest(
  manifest: RunManifest,
  status: RunManifest['status'],
  endedAt?: string,
): RunIndexEntry {
  return {
    runId: manifest.runId,
    ...(manifest.executionType ? { executionType: manifest.executionType } : {}),
    feature: manifest.feature,
    startedAt: manifest.startedAt,
    status,
    ...(endedAt ? { endedAt } : {}),
    ...(manifest.verification?.configName ? { verificationConfigName: manifest.verification.configName } : {}),
    ...(manifest.verification?.playwrightEnvsetId ? { verificationPlaywrightEnvsetId: manifest.verification.playwrightEnvsetId } : {}),
    ...(manifest.verification?.targetUrls ? { verificationTargetUrls: manifest.verification.targetUrls } : {}),
  }
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
  const tmpPath = `${summaryPath}.tmp`
  fs.writeFileSync(tmpPath, JSON.stringify(summary, null, 2) + '\n')
  fs.renameSync(tmpPath, summaryPath)
}
