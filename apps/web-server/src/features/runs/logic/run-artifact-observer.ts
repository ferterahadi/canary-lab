import fs from 'fs'
import path from 'path'
import { createHash } from 'crypto'
import type { RunStore, RunStoreEvent } from './run-store'
import { startRunFileWatcher, type RunFileWatcher, type WatchDirectory } from './run-file-watcher'
import { OBSERVATION_LEASE_MS, createCappedDebounce, type CappedDebounce } from '../../../shared/debounced-watch'
import { RUN_MANIFEST_FILE, runsRoot } from './runtime/run-paths'

export interface RunArtifactObserver {
  observe(runId: string): void
  dispose(): void
}

const JOURNAL = 'diagnosis-journal.md'
const DETAIL = [RUN_MANIFEST_FILE, 'lifecycle-events.jsonl'] as const
const FILES = [...DETAIL, JOURNAL]

interface Observation {
  directory: string
  identity: string
  fingerprints: Map<string, string>
  watcher?: RunFileWatcher
  lease?: ReturnType<typeof setTimeout>
  debounce: CappedDebounce
  failed: boolean
}

/** Read-side hints only: external writers retain ownership of every artifact. */
export function createRunArtifactObserver(deps: {
  store: RunStore
  log(error: Error): void
  watchDirectory?: WatchDirectory
  maxWatches?: number
}): RunArtifactObserver {
  const entries = new Map<string, Observation>()
  let disposed = false
  const fingerprint = (entry: Observation, name: string): string | undefined => {
    try {
      const bytes = fs.readFileSync(path.join(entry.directory, name))
      if (name === RUN_MANIFEST_FILE) {
        const manifest: unknown = JSON.parse(bytes.toString('utf8'))
        if (!manifest || typeof manifest !== 'object' || !('runId' in manifest) || !('status' in manifest)) return undefined
      }
      return createHash('sha256').update(bytes).digest('hex')
    } catch (error) {
      // Partial writes and read failures retain the last accepted fingerprint.
      return name !== RUN_MANIFEST_FILE && (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : undefined
    }
  }
  const capture = (entry: Observation, names: readonly string[]): boolean => {
    let changed = false
    for (const name of names) {
      const next = fingerprint(entry, name)
      if (next === undefined) continue
      if (entry.fingerprints.get(name) !== next) changed = true
      entry.fingerprints.set(name, next)
    }
    return changed
  }
  const release = (id: string, entry: Observation) => {
    entries.delete(id)
    clearTimeout(entry.lease)
    entry.debounce.cancel()
    entry.watcher?.close()
  }
  const unchangedDirectory = (entry: Observation): boolean => {
    try {
      if (fs.realpathSync(entry.directory) !== entry.directory) return false
      const stat = fs.statSync(entry.directory)
      return `${stat.dev}:${stat.ino}` === entry.identity
    } catch {
      return false
    }
  }
  const flush = (id: string, entry: Observation) => {
    if (!unchangedDirectory(entry)) { release(id, entry); return }
    const journalChanged = capture(entry, [JOURNAL])
    // Do not certify a transiently invalid manifest, or consume its pending
    // lifecycle changes before a later valid observation can publish them.
    const detailChanged = fingerprint(entry, RUN_MANIFEST_FILE) !== undefined && capture(entry, DETAIL)
    if (journalChanged) deps.store.recordJournalChange(id)
    if (detailChanged) deps.store.notifyDetailChanged(id)
  }
  const acknowledged = (event: RunStoreEvent) => {
    if (!event.runId) return
    const entry = entries.get(event.runId)
    if (!entry) return
    if (!unchangedDirectory(entry)) { release(event.runId, entry); return }
    if (event.kind === 'removed') { release(event.runId, entry); return }
    if (event.kind === 'journal-changed') capture(entry, [JOURNAL])
    else if (event.kind === 'changed' || event.kind === 'finalized' || event.kind === 'bootstrap') capture(entry, DETAIL)
  }
  deps.store.onEvent(acknowledged)
  return {
    observe(id) {
      if (disposed || !id || id === '.' || id.includes('..') || /[/\\]/.test(id)) return
      let directory: string
      let identity: string
      try {
        const root = fs.realpathSync(runsRoot(deps.store.logsDir))
        directory = fs.realpathSync(path.join(root, id))
        if (path.dirname(directory) !== root) return
        const stat = fs.statSync(directory)
        if (!stat.isDirectory()) return
        identity = `${stat.dev}:${stat.ino}`
      } catch {
        // Reads of missing runs must not create directories or watches.
        return
      }
      let entry = entries.get(id)
      if (entry && (entry.identity !== identity || entry.failed)) { release(id, entry); entry = undefined }
      if (!entry) {
        if (entries.size >= (deps.maxWatches ?? 256)) return
        const created: Observation = { directory, identity, fingerprints: new Map(), failed: false, debounce: createCappedDebounce(() => flush(id, created)) }
        entry = created
        if (fingerprint(entry, RUN_MANIFEST_FILE) === undefined) return
        capture(entry, FILES)
        entries.set(id, entry)
        const current = entry
        current.watcher = startRunFileWatcher({
          directory, filenames: FILES, watchDirectory: deps.watchDirectory,
          onChange() {
            current.debounce.schedule()
          },
          onError(error) {
            current.failed = true
            current.watcher?.close()
            current.debounce.cancel()
            deps.log(error)
          },
        })
      }
      clearTimeout(entry.lease)
      const current = entry
      current.lease = setTimeout(() => release(id, current), OBSERVATION_LEASE_MS)
      current.lease.unref()
    },
    dispose() {
      disposed = true
      deps.store.offEvent(acknowledged)
      for (const [id, entry] of entries) release(id, entry)
    },
  }
}
