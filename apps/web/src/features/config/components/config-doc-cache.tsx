import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

// The feature-config dialog's five tabs read four documents between them, and
// three of them (General / Service / Ports) read the SAME one. Only the open
// tab is mounted, so without a cache every tab click re-fetched a document the
// dialog had already read — and each tab gates its whole body behind `loading`,
// so the click wiped the panel to "Loading…" (measured 15–370ms) for data that
// was in memory a moment earlier.
//
// Scope is the DIALOG, not the app: the cache dies with the provider, so
// reopening the dialog re-reads everything from disk. That is what keeps this
// safe without a staleness policy — within one open, the only writers are the
// dialog's own saves (`setDoc`) and an explicit `refresh()` from a surface that
// knows the file changed underneath it (a portify save rewrites the config doc
// that three tabs read).

interface DocStore {
  read: (key: string) => unknown | undefined
  write: (key: string, doc: unknown) => void
  evict: (key: string) => void
  /** Fetch a key at most once at a time. Two readers that mount in the same
   *  commit both miss the cache, and React's StrictMode double-invokes a mount
   *  effect — either way the same document would otherwise be requested twice. */
  load: (key: string, loader: () => Promise<unknown>) => Promise<unknown>
}

interface CacheValue {
  store: DocStore
  /** Bumped on every eviction so mounted readers re-run their load effect. */
  version: number
}

const ConfigDocCacheContext = createContext<CacheValue | null>(null)

export function ConfigDocCacheProvider({ children }: { children: ReactNode }) {
  const docs = useRef(new Map<string, unknown>())
  const inflight = useRef(new Map<string, Promise<unknown>>())
  const [version, setVersion] = useState(0)

  const store = useMemo<DocStore>(() => ({
    read: (key) => docs.current.get(key),
    write: (key, doc) => { docs.current.set(key, doc) },
    evict: (key) => {
      docs.current.delete(key)
      // Drop the in-flight read too: it was started against the pre-eviction
      // file, so joining it would re-cache exactly what we just threw away.
      inflight.current.delete(key)
      setVersion((v) => v + 1)
    },
    load: (key, loader) => {
      const joined = inflight.current.get(key)
      if (joined) return joined
      const started = loader()
        .then((doc) => { docs.current.set(key, doc); return doc })
        .finally(() => {
          if (inflight.current.get(key) === started) inflight.current.delete(key)
        })
      inflight.current.set(key, started)
      return started
    },
  }), [])

  // Identity changes with `version` on purpose — that is the signal readers
  // subscribe to. The map behind `store` is a ref, so a bump never re-creates it.
  const value = useMemo<CacheValue>(() => ({ store, version }), [store, version])

  return (
    <ConfigDocCacheContext.Provider value={value}>
      {children}
    </ConfigDocCacheContext.Provider>
  )
}

export interface CachedDoc<Doc> {
  doc: Doc | null
  loading: boolean
  error: string | null
  /** Replace the cached document (after a save PUTs and returns the fresh one)
   *  so the other tabs reading the same key see the saved values. */
  setDoc: (doc: Doc) => void
  /** Drop the cached document and re-read it — for a surface that knows the
   *  file changed underneath it. */
  refresh: () => void
}

interface Loaded<Doc> {
  /** The (key, version, reload) triple this state was seeded for — a mismatch
   *  means the identity moved and the state has to be re-seeded. */
  stamp: string
  doc: Doc | null
  error: string | null
}

/** Read a document once per dialog open, then serve it from memory.
 *
 *  A cache hit is seeded into state during render, so the very first painted
 *  frame already has the document and `loading` is false — no "Loading…"
 *  flash, which is the whole point. A miss loads in an effect and shows the
 *  loading state exactly as before.
 *
 *  With no provider above it (an isolated tab unit test) every mount fetches,
 *  which is the pre-cache behaviour — so leaves stay mountable alone. */
export function useCachedDoc<Doc>(key: string, load: () => Promise<Doc>): CachedDoc<Doc> {
  const cache = useContext(ConfigDocCacheContext)
  const store = cache?.store ?? null
  const version = cache?.version ?? 0

  // Callers pass an inline arrow; reading it through a ref keeps the load effect
  // keyed on the document's identity instead of re-running on every render.
  const loadRef = useRef(load)
  loadRef.current = load

  // Bumped by `refresh()` when there is no provider to evict from.
  const [reload, setReload] = useState(0)
  const stamp = `${key}@${version}@${reload}`

  const [state, setState] = useState<Loaded<Doc>>(
    () => ({ stamp, doc: (store?.read(key) as Doc | undefined) ?? null, error: null }),
  )

  // Re-seed during render, not in an effect: an effect would leave one painted
  // frame holding the previous document — or none at all, which is the flash
  // this hook exists to remove.
  if (state.stamp !== stamp) {
    setState({ stamp, doc: (store?.read(key) as Doc | undefined) ?? null, error: null })
  }

  useEffect(() => {
    if (store?.read(key) !== undefined) return
    let cancelled = false
    const reading = store
      ? (store.load(key, loadRef.current as () => Promise<unknown>) as Promise<Doc>)
      : loadRef.current()
    reading
      .then((doc) => {
        if (cancelled) return
        setState((s) => (s.stamp === stamp ? { ...s, doc } : s))
      })
      .catch((e: unknown) => {
        if (cancelled) return
        setState((s) => (s.stamp === stamp ? { ...s, error: e instanceof Error ? e.message : 'Failed to load' } : s))
      })
    return () => { cancelled = true }
  }, [key, stamp, store])

  const setDoc = (doc: Doc): void => {
    store?.write(key, doc)
    setState((s) => ({ ...s, doc, error: null }))
  }

  const refresh = (): void => {
    if (store) store.evict(key)
    else setReload((r) => r + 1)
  }

  return {
    doc: state.doc,
    loading: state.doc == null && state.error == null,
    error: state.error,
    setDoc,
    refresh,
  }
}
