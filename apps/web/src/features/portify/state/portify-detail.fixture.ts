import { useEffect, useMemo, useSyncExternalStore } from 'react'
import type { PortifyManifest } from '@/shared/api/portify'
import { createObservedReads } from '@/shared/state/observed-reads'
import { createRecordIndexHydration } from '@/shared/state/record-index-store'
import { portifyIndex } from './portify-state'

/** Consumer tests exercise the real hydration controller without a socket. */
export function detailFixture(read: (id: string) => Promise<PortifyManifest | undefined>, current: (id: string) => PortifyManifest | undefined = () => undefined) {
  return function useDetail(id?: string | null) {
    const owner = useMemo(() => {
      const details = new Map<string, PortifyManifest>()
      const get = (key: string) => details.get(key) ?? current(key)
      const hydration = createRecordIndexHydration({
        index: portifyIndex, errorMessage: 'Could not load port work', reads: createObservedReads(), read: async (key) => (await read(key))!,
        hasDetail: (key) => Boolean(get(key)), apply: (action) => {
          if (action.type === 'update') details.set(action.workflowId, action.manifest)
          if (action.type === 'detail-missing') details.delete(action.workflowId)
        } })
      return { hydration, get }
    }, [])
    const status = useSyncExternalStore(owner.hydration.subscribe, () => owner.hydration.snapshot(id))
    useEffect(() => { owner.hydration.start(); return owner.hydration.stop }, [owner])
    useEffect(() => id ? owner.hydration.watch(id) : undefined, [owner, id])
    const manifest = id ? owner.get(id) : undefined
    return { manifest, loading: Boolean(id && !manifest && ['idle', 'loading'].includes(status.status)), error: status.error,
      missing: status.status === 'missing', retry: () => { if (id) owner.hydration.retry(id) } }
  }
}
