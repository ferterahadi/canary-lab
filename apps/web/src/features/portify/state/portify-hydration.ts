import type { PortifyManifest } from '@/shared/api/client'
import { createDetailHydration } from '@/shared/state/detail-hydration'
import type { createObservedReads } from '@/shared/state/observed-reads'
import type { PortifyAction } from './portify-state'

/** Portify supplies domain actions; the provider owns manifests and read tokens. */
export function createPortifyHydration({ reads, read, apply, hasDetail }: {
  reads: ReturnType<typeof createObservedReads>
  read: (id: string) => Promise<PortifyManifest>
  apply: (action: PortifyAction) => void
  hasDetail: (id: string) => boolean
}) {
  const hydration = createDetailHydration({
    reads, read, hasDetail, errorMessage: 'Could not load port work',
    apply: (workflowId, manifest) => apply({ type: 'update', workflowId, manifest }),
    missing: (workflowId) => apply({ type: 'detail-missing', workflowId }),
  })
  return { ...hydration, observe: (action: PortifyAction) => {
    if (action.type === 'update' || action.type === 'removed') hydration.observe({ type: action.type, id: action.workflowId })
    if (action.type === 'snapshot') hydration.observe({ type: 'snapshot', ids: action.workflows.map((row) => row.workflowId), details: action.details })
  } }
}
