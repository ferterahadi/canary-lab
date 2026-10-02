import { createContext, useCallback, useContext, useMemo, useSyncExternalStore, type ReactNode } from 'react'
import { useInvalidationKey } from '@/shared/state/invalidation'
import { useLiveResource } from '@/shared/state/use-live-resource'
import { createConfigDocStore } from '../state/config-doc-store'

const ConfigDocCacheContext = createContext<ReturnType<typeof createConfigDocStore> | null>(null)

/** One cache per open dialog: tabs share reads without keeping workspace secrets
 * in a module-global cache after the dialog closes. Only mounted readers poll. */
export function ConfigDocCacheProvider({ children }: { children: ReactNode }) {
  const store = useMemo(createConfigDocStore, [])
  return <ConfigDocCacheContext.Provider value={store}>{children}</ConfigDocCacheContext.Provider>
}

export interface CachedDoc<Doc> {
  doc: Doc | null
  loading: boolean
  error: string | null
  setDoc: (doc: Doc) => void
  refresh: () => void
}

export function useCachedDoc<Doc>(key: string, load: () => Promise<Doc>): CachedDoc<Doc> {
  const shared = useContext(ConfigDocCacheContext)
  const local = useMemo(createConfigDocStore, [])
  const store = shared ?? local
  const subscribe = useCallback((listener: () => void) => store.subscribe(key, listener), [key, store])
  const snapshot = useSyncExternalStore(subscribe, () => store.read(key))
  const globalVersion = useInvalidationKey('configuration')
  // All existing document keys use kind:suite[:env:slot]. Invalidation scopes
  // the suite while the full key keeps the individual documents independent.
  const scope = key.split(':')[1]
  const resource = useLiveResource('configuration', key,
    (_key, options) => store.load(key, options!.readRevision, load), {
      scope,
      reconcileMs: 5000,
      refreshKey: `${globalVersion}:${snapshot.generation}`,
    })
  const setDoc = useCallback((doc: Doc) => store.write(key, doc), [key, store])
  const refresh = useCallback(() => store.invalidate(key), [key, store])
  const error = snapshot.error ?? resource.error
  return { doc: snapshot.doc as Doc | null, loading: snapshot.doc === null && error === null, error, setDoc, refresh }
}
