import type { Approval } from '@shared/approval'
import { request, requestSnapshot, type ClientOptions } from './internal'

export const getApprovals = (opts?: ClientOptions): Promise<Approval[]> => requestSnapshot('/api/approvals', opts)
export const answerApproval = (id: string, answer: Record<string, unknown>): Promise<Approval> =>
  request(`/api/approvals/${encodeURIComponent(id)}/answer`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ answer }),
  }, globalThis.fetch.bind(globalThis))
