import { displayError } from '@/shared/api/error-message'
export interface ConfigDocSnapshot {
  doc: unknown | null
  error: string | null
  generation: number
}

interface Entry {
  snapshot: ConfigDocSnapshot
  revision: string | null
  request: { revision: string; promise: Promise<unknown> } | null
  saved: boolean
  listeners: Set<() => void>
}

/** Dialog-local cache. Request revisions come from useLiveResource, which owns
 * event delivery, reconciliation timing, focus/reconnect recovery and teardown. */
export function createConfigDocStore() {
  const entries = new Map<string, Entry>()
  const entryFor = (key: string): Entry => {
    let entry = entries.get(key)
    if (!entry) {
      entry = { snapshot: { doc: null, error: null, generation: 0 }, revision: null, request: null, saved: false, listeners: new Set() }
      entries.set(key, entry)
    }
    return entry
  }
  const publish = (entry: Entry, snapshot: ConfigDocSnapshot): void => {
    entry.snapshot = snapshot
    for (const listener of entry.listeners) listener()
  }
  return {
    read: (key: string): ConfigDocSnapshot => entryFor(key).snapshot,
    subscribe: (key: string, listener: () => void): (() => void) => {
      const entry = entryFor(key)
      entry.listeners.add(listener)
      return () => { entry.listeners.delete(listener) }
    },
    write: (key: string, doc: unknown): void => {
      const entry = entryFor(key)
      entry.request = null
      entry.saved = true
      entry.revision = null
      publish(entry, { doc, error: null, generation: entry.snapshot.generation + 1 })
    },
    invalidate: (key: string): void => {
      const entry = entryFor(key)
      entry.request = null
      entry.saved = false
      entry.revision = null
      publish(entry, { ...entry.snapshot, generation: entry.snapshot.generation + 1 })
    },
    load: (key: string, revision: string, loader: () => Promise<unknown>): Promise<unknown> => {
      const entry = entryFor(key)
      if (entry.saved || (entry.revision === revision && entry.snapshot.doc !== null)) {
        entry.saved = false
        entry.revision = revision
        return Promise.resolve(entry.snapshot.doc)
      }
      if (entry.request?.revision === revision) return entry.request.promise
      const request = { revision, promise: Promise.resolve<unknown>(null) }
      entry.request = request
      request.promise = Promise.resolve().then(loader).then((doc) => {
        if (entry.request === request) {
          entry.revision = revision
          // Equal reads keep the document identity, including an editor's draft.
          if (entry.snapshot.error || JSON.stringify(entry.snapshot.doc) !== JSON.stringify(doc)) {
            publish(entry, { ...entry.snapshot, doc, error: null })
          }
        }
        return doc
      }).catch((error: unknown) => {
        if (entry.request === request) {
          publish(entry, { ...entry.snapshot, error: displayError(error, 'Failed to load') })
        }
        throw error
      }).finally(() => { if (entry.request === request) entry.request = null })
      return request.promise
    },
  }
}
