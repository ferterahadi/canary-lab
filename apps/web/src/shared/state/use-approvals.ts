import { useLiveResource } from './use-live-resource'
import { getApprovals, answerApproval } from '../api/approvals'

/** App owns this resource once for the banner and the routed inbox. Push is
 * backed by two-second reconciliation, including when a new question is missed. */
export function useApprovals() {
  const resource = useLiveResource('approvals', 'workspace', (_key, opts) => getApprovals(opts), { reconcileMs: 2000 })
  return { ...resource, items: resource.value ?? [], answer: async (id: string, value: Record<string, unknown>) => {
    const result = await answerApproval(id, value)
    resource.accept((current) => [...(current ?? []).filter((item) => item.id !== id), result])
    resource.refresh()
  } }
}
export type ApprovalsResource = ReturnType<typeof useApprovals>
