import fs from 'fs'
import path from 'path'
import { portifyIndexPath, portifyDir, buildPortifyPaths } from './paths'
import type { PortifyManifest, PortifyIndexEntry } from './types'

// File-backed, event-emitting store for port-ification workflows. Mirrors
// BenchmarkRunStore: `save()` writes the manifest + upserts the index, then
// emits `changed` (the WS/poll push point). Reads come straight off disk.

function atomicWrite(file: string, body: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, body)
  fs.renameSync(tmp, file)
}

function readManifestAt(manifestPath: string): PortifyManifest | null {
  try {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as PortifyManifest
  } catch {
    return null
  }
}

function readIndex(logsDir: string): PortifyIndexEntry[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(portifyIndexPath(logsDir), 'utf-8'))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function indexEntryFromManifest(m: PortifyManifest): PortifyIndexEntry {
  return {
    workflowId: m.workflowId,
    feature: m.feature,
    status: m.status,
    branch: m.branch,
    startedAt: m.startedAt,
    ...(m.endedAt ? { endedAt: m.endedAt } : {}),
    ...(m.mergedAt ? { mergedAt: m.mergedAt } : {}),
  }
}

export interface PortifyStoreEvent {
  kind: 'changed' | 'removed'
  workflowId?: string
}

export interface PortifyStore {
  list(): PortifyIndexEntry[]
  get(workflowId: string): PortifyManifest | null
  save(manifest: PortifyManifest): void
  remove(workflowId: string): void
  onEvent(fn: (event: PortifyStoreEvent) => void): void
  offEvent(fn: (event: PortifyStoreEvent) => void): void
}

export class PortifyRunStore implements PortifyStore {
  private readonly listeners = new Set<(event: PortifyStoreEvent) => void>()

  constructor(private readonly logsDir: string) {}

  list(): PortifyIndexEntry[] {
    return readIndex(this.logsDir)
  }

  get(workflowId: string): PortifyManifest | null {
    const { manifestPath } = buildPortifyPaths(portifyDir(this.logsDir, workflowId))
    return readManifestAt(manifestPath)
  }

  save(manifest: PortifyManifest): void {
    const { manifestPath } = buildPortifyPaths(portifyDir(this.logsDir, manifest.workflowId))
    atomicWrite(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
    const entries = readIndex(this.logsDir)
    const idx = entries.findIndex((e) => e.workflowId === manifest.workflowId)
    const entry = indexEntryFromManifest(manifest)
    if (idx === -1) entries.push(entry)
    else entries[idx] = { ...entries[idx], ...entry }
    atomicWrite(portifyIndexPath(this.logsDir), JSON.stringify(entries, null, 2) + '\n')
    this.emit({ kind: 'changed', workflowId: manifest.workflowId })
  }

  /**
   * Flip any workflow left in a non-terminal state by a dead process to
   * `aborted`. Its in-memory driver was killed on restart, so it can never
   * finish — flip it so the UI doesn't show it as live forever. (Orphaned
   * worktrees + branches are reclaimed separately via the worktree inventory.)
   */
  /**
   * Drop a workflow from history: remove its index entry and run directory,
   * then emit `removed` so live clients prune it. Does NOT touch any git branch
   * a committed workflow landed — that's the user's work in their own repo.
   * No-op (still emits) if the entry is already gone.
   */
  remove(workflowId: string): void {
    const entries = readIndex(this.logsDir).filter((e) => e.workflowId !== workflowId)
    atomicWrite(portifyIndexPath(this.logsDir), JSON.stringify(entries, null, 2) + '\n')
    try { fs.rmSync(portifyDir(this.logsDir, workflowId), { recursive: true, force: true }) } catch { /* best-effort */ }
    this.emit({ kind: 'removed', workflowId })
  }

  reconcileInterrupted(now: () => string): void {
    for (const entry of this.list()) {
      if (entry.status === 'committed' || entry.status === 'failed' || entry.status === 'aborted') continue
      // 'ready-to-commit' is also non-terminal but awaits a user action; a dead
      // process can't hold that worktree, so it too becomes aborted.
      const m = this.get(entry.workflowId)
      if (!m) continue
      this.save({
        ...m,
        status: 'aborted',
        endedAt: m.endedAt ?? now(),
        error: m.error ?? 'Interrupted by server restart',
      })
    }
  }

  onEvent(fn: (event: PortifyStoreEvent) => void): void {
    this.listeners.add(fn)
  }

  offEvent(fn: (event: PortifyStoreEvent) => void): void {
    this.listeners.delete(fn)
  }

  private emit(event: PortifyStoreEvent): void {
    for (const fn of this.listeners) {
      try { fn(event) } catch { /* a bad listener must not break persistence */ }
    }
  }
}
