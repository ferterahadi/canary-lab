import fs from 'fs'
import path from 'path'
import { readManifest, readRunsIndex, updateManifest, upsertRunsIndexEntry, writeRunsIndex, type RunManifest } from './runtime/manifest'
import { runDirFor, runsRoot } from './runtime/run-paths'
import { FileRunStateSink } from './runtime/run-state-sink'
import type { ExecutionType } from '../../../../../../shared/verification'
import {
  HEARTBEAT_STALE_MS,
  isActiveRunStatus,
  isStaleHeartbeat,
} from '../../../../../../shared/run-state'
import { dirSizeBytes, runArtifactBytes } from './run-artifacts'
import type { OrchestratorRegistry } from './run-registry'
import { RunStore } from './run-store'

/**
 * One-shot cleanup for runs left in `running`/`healing` state by a previous
 * server process that crashed without writing a final status. Intended to run
 * once at server boot — never on a hot read path. A run is reaped only when
 * its manifest carries a `heartbeatAt` older than `HEARTBEAT_STALE_MS`; runs
 * with no `heartbeatAt` (legacy manifests written before the field existed)
 * are left untouched.
 */
export async function reapStaleRuns(
  logsDir: string,
  registry?: OrchestratorRegistry,
): Promise<void> {
  const all = readRunsIndex(logsDir)
  const now = Date.now()

  for (const entry of all) {
    if (!isActiveRunStatus(entry.status)) continue
    const manifestPath = path.join(runDirFor(logsDir, entry.runId), 'manifest.json')
    const manifest = readManifest(manifestPath)
    if (!manifest) {
      // Active index entry with no readable manifest. A live run always writes
      // its manifest before its index entry (FileRunStateSink.bootstrap), so
      // this is an orphan left by a process that died mid-teardown (e.g. a
      // boot/manual-services run) — UNLESS an orchestrator is still registered
      // for it, in which case the run is genuinely live and the manifest read
      // merely glitched: leave it alone. Reap the orphan straight from the
      // index so it can't stay stuck active forever.
      if (registry?.get(entry.runId)) continue
      upsertRunsIndexEntry(logsDir, {
        ...entry,
        status: 'aborted',
        endedAt: entry.endedAt ?? new Date(now).toISOString(),
      })
      continue
    }
    if (!manifest.heartbeatAt) continue
    if (!isStaleHeartbeat(manifest.heartbeatAt, now, HEARTBEAT_STALE_MS)) continue

    const orch = registry?.get(entry.runId)
    if (orch) {
      await orch.stop('aborted').catch(() => {})
      registry!.delete(entry.runId)
    }

    const endedAt = manifest.heartbeatAt
    updateManifest(manifestPath, { status: 'aborted', endedAt })
    upsertRunsIndexEntry(logsDir, { ...entry, status: 'aborted', endedAt })
  }
}

/**
 * Remove a run from history: drop its entry from `runs/index.json` and
 * recursively delete the run directory. Returns `true` when something was
 * actually removed (entry existed or directory existed), `false` when
 * neither did. Caller is responsible for verifying the run is in a terminal
 * state — this does NOT stop a running orchestrator.
 */
export function removeRunFromHistory(logsDir: string, runId: string): boolean {
  let changed = false
  const entries = readRunsIndex(logsDir)
  const next = entries.filter((e) => e.runId !== runId)
  if (next.length !== entries.length) {
    writeRunsIndex(logsDir, next)
    changed = true
  }
  const dir = runDirFor(logsDir, runId)
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true })
    changed = true
  }
  return changed
}

export interface DeleteResult {
  ok: boolean
  reason?: 'active' | 'not-found' | 'stale'
}

export interface TrimResult {
  ok: boolean
  reason?: 'active' | 'not-found' | 'stale'
  /** Bytes reclaimed by removing the artifact dirs. Present when `ok`. */
  freedBytes?: number
}

/** One indexed run, annotated with disk usage for the cleanup view. */
export interface CleanupRunEntry {
  runId: string
  feature: string
  executionType: ExecutionType
  status: RunManifest['status']
  startedAt: string
  endedAt?: string
  /** Total bytes of the whole run directory. */
  folderBytes: number
  /** Bytes held by the trimmable Playwright artifact dirs (subset of folder). */
  artifactBytes: number
  /** True when the run is still live (registered orchestrator or active status).
   *  Active runs cannot be trimmed or deleted. */
  active: boolean
}

/** A directory under `logs/runs/` with no entry in `index.json` — an
 *  interrupted/never-finalized run. Delete-only; it has no manifest. */
export interface CleanupOrphan {
  runId: string
  folderBytes: number
}

export interface CleanupListing {
  runs: CleanupRunEntry[]
  orphans: CleanupOrphan[]
  totals: {
    /** Every run folder + every orphan folder. */
    totalBytes: number
    /** Artifact bytes reclaimable by trimming non-active runs. */
    reclaimableTrimBytes: number
    /** Folder bytes reclaimable by deleting non-active runs + all orphans. */
    reclaimableDeleteBytes: number
  }
}

/** Build the cleanup view: every indexed run annotated with disk usage and an
 *  `active` flag, plus orphan directories not present in the index, plus
 *  reclaimable totals. `isActive(runId, status)` lets the RunStore overlay the
 *  live orchestrator registry on top of the persisted status. */
export function listCleanupEntries(
  logsDir: string,
  isActive: (runId: string, status: RunManifest['status']) => boolean = (_id, status) => isActiveRunStatus(status),
): CleanupListing {
  const index = readRunsIndex(logsDir)
  const indexed = new Set(index.map((e) => e.runId))

  const runs: CleanupRunEntry[] = index.map((entry) => {
    const folderBytes = dirSizeBytes(runDirFor(logsDir, entry.runId))
    const artifactBytes = runArtifactBytes(logsDir, entry.runId)
    return {
      runId: entry.runId,
      feature: entry.feature,
      executionType: entry.executionType ?? 'run',
      status: entry.status,
      startedAt: entry.startedAt,
      ...(entry.endedAt ? { endedAt: entry.endedAt } : {}),
      folderBytes,
      artifactBytes,
      active: isActive(entry.runId, entry.status),
    }
  })

  const orphans: CleanupOrphan[] = []
  const root = runsRoot(logsDir)
  let rootEntries: fs.Dirent[] = []
  try {
    rootEntries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    rootEntries = []
  }
  for (const entry of rootEntries) {
    if (!entry.isDirectory()) continue
    if (indexed.has(entry.name)) continue
    orphans.push({ runId: entry.name, folderBytes: dirSizeBytes(path.join(root, entry.name)) })
  }

  const totalBytes =
    runs.reduce((sum, r) => sum + r.folderBytes, 0) +
    orphans.reduce((sum, o) => sum + o.folderBytes, 0)
  const reclaimableTrimBytes = runs
    .filter((r) => !r.active)
    .reduce((sum, r) => sum + r.artifactBytes, 0)
  const reclaimableDeleteBytes =
    runs.filter((r) => !r.active).reduce((sum, r) => sum + r.folderBytes, 0) +
    orphans.reduce((sum, o) => sum + o.folderBytes, 0)

  return { runs, orphans, totals: { totalBytes, reclaimableTrimBytes, reclaimableDeleteBytes } }
}

export interface AbortResult {
  ok: boolean
  reason?: 'not-active'
}

export interface AbortAllResult {
  aborted: string[]
}
