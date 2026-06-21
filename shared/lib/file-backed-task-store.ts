import fs from 'fs'
import path from 'path'
import { atomicWrite } from './atomic-write'

// Generic file-backed, event-emitting store for a feature's background-task /
// workflow records. One home for the layout every Canary Lab feature store had
// re-implemented by hand: a per-record directory holding the record JSON, plus
// a single `index.json` of lightweight rows for fast listing, with atomic
// writes, `changed`/`removed` events, an optional state-machine guard, and
// crash recovery (`reconcileInterrupted`).
//
// Layout: <logsDir>/<dirName>/<id>/<recordFile> for each record, and
// <logsDir>/<dirName>/index.json for the index. The per-record directory is
// also where a feature parks its sidecar files (agent logs, prd.md, zips) —
// `recordDir(id)` exposes it.

export interface TaskStoreEvent {
  kind: 'changed' | 'removed'
  id?: string
}

export interface TaskIndexEntry {
  id: string
  createdAt: string
  [key: string]: unknown
}

export interface TaskStoreConfig<T> {
  logsDir: string
  /** Subdirectory under logsDir that owns this store's records + index. */
  dirName: string
  /** Filename of the record JSON inside each per-record directory. */
  recordFile: string
  idOf: (rec: T) => string
  /** Lightweight row written to index.json. Must include `id` and `createdAt`. */
  indexEntryOf: (rec: T) => TaskIndexEntry
  /** Current status, used by `transition` + the default index sort tiebreak. */
  statusOf?: (rec: T) => string
  /** Validate/normalize an untrusted record read from disk; return null to drop. */
  validate?: (raw: unknown) => T | null
  /** State-machine guard for `transition`. Absent → any transition allowed. */
  allowedTransitions?: Record<string, string[]>
  /** When true, `list()` returns records newest-first by `createdAt`; otherwise
   *  index insertion order is preserved. */
  sortNewestFirst?: boolean
  /** Crash recovery: which records a dead process left mid-flight, and how to
   *  mark them terminal on restart. Absent → reconcileInterrupted is a no-op. */
  reconcile?: {
    isInterrupted: (rec: T) => boolean
    mark: (rec: T, now: string) => T
  }
}

export class IllegalTaskTransitionError extends Error {
  constructor(public readonly from: string, public readonly to: string) {
    super(`Illegal task transition: ${from} → ${to}`)
  }
}

export class FileBackedTaskStore<T> {
  private readonly listeners = new Set<(event: TaskStoreEvent) => void>()

  constructor(private readonly config: TaskStoreConfig<T>) {}

  private get root(): string {
    return path.join(this.config.logsDir, this.config.dirName)
  }

  private get indexPath(): string {
    return path.join(this.root, 'index.json')
  }

  /** The per-record directory — also where a feature parks sidecar files. */
  recordDir(id: string): string {
    return path.join(this.root, id)
  }

  private recordPath(id: string): string {
    return path.join(this.recordDir(id), this.config.recordFile)
  }

  get(id: string): T | null {
    const p = this.recordPath(id)
    let raw: unknown
    try {
      raw = JSON.parse(fs.readFileSync(p, 'utf8'))
    } catch {
      return null
    }
    return this.config.validate ? this.config.validate(raw) : (raw as T)
  }

  list(): TaskIndexEntry[] {
    const entries = this.readIndex()
    if (!this.config.sortNewestFirst) return entries
    return entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  private readIndex(): TaskIndexEntry[] {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.indexPath, 'utf8'))
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }

  private writeIndex(entries: TaskIndexEntry[]): void {
    atomicWrite(this.indexPath, JSON.stringify(entries, null, 2) + '\n')
  }

  save(rec: T): void {
    const id = this.config.idOf(rec)
    atomicWrite(this.recordPath(id), JSON.stringify(rec, null, 2) + '\n')
    const entries = this.readIndex()
    const entry = this.config.indexEntryOf(rec)
    const idx = entries.findIndex((e) => e.id === id)
    if (idx === -1) entries.push(entry)
    else entries[idx] = { ...entries[idx], ...entry }
    this.writeIndex(entries)
    this.emit({ kind: 'changed', id })
  }

  patch(id: string, patch: Partial<T>): T | null {
    const current = this.get(id)
    if (!current) return null
    const next = { ...current, ...patch } as T
    this.save(next)
    return next
  }

  transition(id: string, to: string, patch: Partial<T> = {}): T {
    const current = this.get(id)
    if (!current) throw new Error(`record not found: ${id}`)
    const allowed = this.config.allowedTransitions
    if (allowed) {
      const from = this.config.statusOf ? this.config.statusOf(current) : ''
      if (!(allowed[from] ?? []).includes(to)) {
        throw new IllegalTaskTransitionError(from, to)
      }
    }
    const next = { ...current, ...patch, status: to } as T
    this.save(next)
    return next
  }

  remove(id: string): void {
    const entries = this.readIndex().filter((e) => e.id !== id)
    this.writeIndex(entries)
    try {
      fs.rmSync(this.recordDir(id), { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
    this.emit({ kind: 'removed', id })
  }

  reconcileInterrupted(now: () => string): void {
    const r = this.config.reconcile
    if (!r) return
    for (const entry of this.list()) {
      const rec = this.get(entry.id)
      if (!rec || !r.isInterrupted(rec)) continue
      this.save(r.mark(rec, now()))
    }
  }

  onEvent(fn: (event: TaskStoreEvent) => void): void {
    this.listeners.add(fn)
  }

  offEvent(fn: (event: TaskStoreEvent) => void): void {
    this.listeners.delete(fn)
  }

  private emit(event: TaskStoreEvent): void {
    for (const fn of this.listeners) {
      try {
        fn(event)
      } catch {
        /* a bad listener must not break persistence */
      }
    }
  }
}
