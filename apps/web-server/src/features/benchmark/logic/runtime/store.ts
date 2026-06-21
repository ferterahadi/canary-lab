import fs from 'fs'
import path from 'path'
import { benchmarksIndexPath, benchmarkDir, buildBenchmarkPaths } from './paths'
import type { BenchmarkManifest, BenchmarkIndexEntry } from './types'
import { atomicWrite } from '../../../../../../../shared/lib/atomic-write'

export function writeBenchmarkManifest(
  manifestPath: string,
  manifest: BenchmarkManifest,
): void {
  atomicWrite(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
}

export function readBenchmarkManifest(manifestPath: string): BenchmarkManifest | null {
  try {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as BenchmarkManifest
  } catch {
    return null
  }
}

export function updateBenchmarkManifest(
  manifestPath: string,
  patch: Partial<BenchmarkManifest>,
): BenchmarkManifest | null {
  const current = readBenchmarkManifest(manifestPath)
  if (!current) return null
  const next = { ...current, ...patch }
  writeBenchmarkManifest(manifestPath, next)
  return next
}

export function readBenchmarksIndex(logsDir: string): BenchmarkIndexEntry[] {
  try {
    const raw = fs.readFileSync(benchmarksIndexPath(logsDir), 'utf-8')
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export function writeBenchmarksIndex(
  logsDir: string,
  entries: BenchmarkIndexEntry[],
): void {
  atomicWrite(benchmarksIndexPath(logsDir), JSON.stringify(entries, null, 2) + '\n')
}

export function upsertBenchmarkIndexEntry(
  logsDir: string,
  entry: BenchmarkIndexEntry,
): BenchmarkIndexEntry[] {
  const entries = readBenchmarksIndex(logsDir)
  const idx = entries.findIndex((e) => e.benchmarkId === entry.benchmarkId)
  if (idx === -1) {
    entries.push(entry)
  } else {
    entries[idx] = { ...entries[idx], ...entry }
  }
  writeBenchmarksIndex(logsDir, entries)
  return entries
}

// Stateful store interface consumed by the REST routes + WS stream (mirrors
// RunStore). The concrete event-emitting implementation is wired in
// createServer alongside the runner. Kept as an interface here so the routes
// and the WS endpoint depend only on the shape, not the wiring.
export interface BenchmarkStoreEvent {
  kind: 'changed' | 'removed' | 'index-changed'
  benchmarkId?: string
}

export interface BenchmarkStore {
  list(): BenchmarkIndexEntry[]
  get(benchmarkId: string): BenchmarkManifest | null
  /** Persist a manifest and push a `changed` event to WS subscribers. Used by
   *  routes that mutate a benchmark out-of-band (e.g. clearing worktrees). */
  save(manifest: BenchmarkManifest): void
  onEvent(fn: (event: BenchmarkStoreEvent) => void): void
  offEvent(fn: (event: BenchmarkStoreEvent) => void): void
}

function indexEntryFromManifest(m: BenchmarkManifest): BenchmarkIndexEntry {
  return {
    benchmarkId: m.benchmarkId,
    feature: m.feature,
    level: m.level,
    status: m.status,
    startedAt: m.startedAt,
    ...(m.endedAt ? { endedAt: m.endedAt } : {}),
  }
}

/**
 * File-backed, event-emitting benchmark store (the benchmark analogue of
 * RunStore). `save()` writes the manifest + upserts the index, then emits a
 * `changed` event — that emission is the WS push point. Reads come straight off
 * disk so the WS frames always carry the latest manifest.
 */
export class BenchmarkRunStore implements BenchmarkStore {
  private readonly listeners = new Set<(event: BenchmarkStoreEvent) => void>()

  constructor(private readonly logsDir: string) {}

  list(): BenchmarkIndexEntry[] {
    return readBenchmarksIndex(this.logsDir)
  }

  get(benchmarkId: string): BenchmarkManifest | null {
    const { manifestPath } = buildBenchmarkPaths(benchmarkDir(this.logsDir, benchmarkId))
    return readBenchmarkManifest(manifestPath)
  }

  /** Persist the manifest + index entry, then notify subscribers. */
  save(manifest: BenchmarkManifest): void {
    const { manifestPath } = buildBenchmarkPaths(benchmarkDir(this.logsDir, manifest.benchmarkId))
    writeBenchmarkManifest(manifestPath, manifest)
    upsertBenchmarkIndexEntry(this.logsDir, indexEntryFromManifest(manifest))
    this.emit({ kind: 'changed', benchmarkId: manifest.benchmarkId })
  }

  /**
   * Mark any benchmark left non-terminal by a previous process as `aborted`.
   * Called once at startup: a `sabotaging`/`ready`/`running` benchmark in the
   * index belongs to a dead process (its in-memory driver was killed on
   * restart), so it can never finish or be aborted live — flip it here so it
   * doesn't resume forever as "running" in the UI. Each flip emits `changed`.
   */
  reconcileInterrupted(now: () => string): void {
    for (const entry of this.list()) {
      if (entry.status !== 'sabotaging' && entry.status !== 'ready' && entry.status !== 'running') {
        continue
      }
      const m = this.get(entry.benchmarkId)
      if (!m) continue
      this.save({
        ...m,
        status: 'aborted',
        endedAt: m.endedAt ?? now(),
        error: m.error ?? 'Interrupted by server restart',
      })
    }
  }

  /** Drop a benchmark from the index, delete its dir, and notify subscribers. */
  remove(benchmarkId: string): void {
    const remaining = readBenchmarksIndex(this.logsDir).filter(
      (e) => e.benchmarkId !== benchmarkId,
    )
    writeBenchmarksIndex(this.logsDir, remaining)
    try {
      fs.rmSync(benchmarkDir(this.logsDir, benchmarkId), { recursive: true, force: true })
    } catch {
      /* already gone */
    }
    this.emit({ kind: 'removed', benchmarkId })
  }

  onEvent(fn: (event: BenchmarkStoreEvent) => void): void {
    this.listeners.add(fn)
  }

  offEvent(fn: (event: BenchmarkStoreEvent) => void): void {
    this.listeners.delete(fn)
  }

  private emit(event: BenchmarkStoreEvent): void {
    for (const fn of this.listeners) {
      try {
        fn(event)
      } catch {
        /* a bad listener must not break persistence */
      }
    }
  }
}
