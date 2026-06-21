import fs from 'fs'
import path from 'path'
import { coverageJobsIndexPath, coverageJobDir, buildCoverageJobPaths } from '../../../../coverage/logic/coverage/jobs/paths'
import type { CoverageJobManifest, CoverageJobIndexEntry, CoverageJobKind } from './types'
import { atomicWrite } from '../../../../../../../../shared/lib/atomic-write'

// File-backed, event-emitting store for coverage background jobs. Mirrors
// PortifyRunStore: `save()` writes the manifest + upserts the index, then emits
// `changed` (the WS/poll push point). Reads come straight off disk so a restart
// recovers history; `reconcileInterrupted` flips jobs a dead process abandoned.

function readManifestAt(manifestPath: string): CoverageJobManifest | null {
  try {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as CoverageJobManifest
  } catch {
    return null
  }
}

function readIndex(logsDir: string): CoverageJobIndexEntry[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(coverageJobsIndexPath(logsDir), 'utf-8'))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function indexEntryFromManifest(m: CoverageJobManifest): CoverageJobIndexEntry {
  return {
    jobId: m.jobId,
    feature: m.feature,
    kind: m.kind,
    status: m.status,
    startedAt: m.startedAt,
    ...(m.endedAt ? { endedAt: m.endedAt } : {}),
  }
}

export interface CoverageJobStoreEvent {
  kind: 'changed' | 'removed'
  jobId?: string
}

export interface CoverageJobStore {
  list(): CoverageJobIndexEntry[]
  get(jobId: string): CoverageJobManifest | null
  /** The currently-running job for a feature+kind, if any (single-flight key). */
  activeFor(feature: string, kind: CoverageJobKind): CoverageJobIndexEntry | null
  save(manifest: CoverageJobManifest): void
  remove(jobId: string): void
  reconcileInterrupted(now: () => string): void
  onEvent(fn: (event: CoverageJobStoreEvent) => void): void
  offEvent(fn: (event: CoverageJobStoreEvent) => void): void
}

export class CoverageJobRunStore implements CoverageJobStore {
  private readonly listeners = new Set<(event: CoverageJobStoreEvent) => void>()

  constructor(private readonly logsDir: string) {}

  list(): CoverageJobIndexEntry[] {
    return readIndex(this.logsDir)
  }

  get(jobId: string): CoverageJobManifest | null {
    const { manifestPath } = buildCoverageJobPaths(coverageJobDir(this.logsDir, jobId))
    return readManifestAt(manifestPath)
  }

  activeFor(feature: string, kind: CoverageJobKind): CoverageJobIndexEntry | null {
    return this.list().find(
      (e) => e.feature === feature && e.kind === kind && e.status === 'running',
    ) ?? null
  }

  save(manifest: CoverageJobManifest): void {
    const { manifestPath } = buildCoverageJobPaths(coverageJobDir(this.logsDir, manifest.jobId))
    atomicWrite(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
    const entries = readIndex(this.logsDir)
    const idx = entries.findIndex((e) => e.jobId === manifest.jobId)
    const entry = indexEntryFromManifest(manifest)
    if (idx === -1) entries.push(entry)
    else entries[idx] = { ...entries[idx], ...entry }
    atomicWrite(coverageJobsIndexPath(this.logsDir), JSON.stringify(entries, null, 2) + '\n')
    this.emit({ kind: 'changed', jobId: manifest.jobId })
  }

  remove(jobId: string): void {
    const entries = readIndex(this.logsDir).filter((e) => e.jobId !== jobId)
    atomicWrite(coverageJobsIndexPath(this.logsDir), JSON.stringify(entries, null, 2) + '\n')
    try { fs.rmSync(coverageJobDir(this.logsDir, jobId), { recursive: true, force: true }) } catch { /* best-effort */ }
    this.emit({ kind: 'removed', jobId })
  }

  /** Flip any job left `running` by a dead process to `aborted` — its in-memory
   *  driver was killed on restart, so it can never finish. Frees the single-
   *  flight lock so the user can start a fresh job. */
  reconcileInterrupted(now: () => string): void {
    for (const entry of this.list()) {
      if (entry.status !== 'running') continue
      const m = this.get(entry.jobId)
      if (!m) continue
      this.save({
        ...m,
        status: 'aborted',
        endedAt: m.endedAt ?? now(),
        error: m.error ?? 'Interrupted by server restart',
      })
    }
  }

  onEvent(fn: (event: CoverageJobStoreEvent) => void): void {
    this.listeners.add(fn)
  }

  offEvent(fn: (event: CoverageJobStoreEvent) => void): void {
    this.listeners.delete(fn)
  }

  private emit(event: CoverageJobStoreEvent): void {
    for (const fn of this.listeners) {
      try { fn(event) } catch { /* a bad listener must not break persistence */ }
    }
  }
}
