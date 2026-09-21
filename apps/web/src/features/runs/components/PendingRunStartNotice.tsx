import { useEffect, useRef, useState } from 'react'
import * as api from '@/shared/api/client'
import { useLiveResource } from '@/shared/state/use-live-resource'
import type { RunStartRequest } from '@shared/test-review'
import type { PendingRunStart } from '../state/pending-run-starts'

interface Props {
  pending: PendingRunStart
  onRunStarted: (runId: string) => void
  onReview: (feature: string, runId: string) => void
  onDismiss: (requestId: string) => void
}

function requestMessage(request: RunStartRequest): string {
  switch (request.status) {
    case 'awaiting-review': return 'Waiting for your test review.'
    case 'ready': return request.owner.kind === 'external'
      ? 'Review complete — waiting for your original external client to continue.' : 'Review complete — preparing your requested run.'
    case 'starting': return 'Review complete — starting your requested run.'
    case 'started': return 'Your requested run has started.'
    case 'queued': return 'Your requested run is queued.'
    case 'cancelled': return 'Run request cancelled. Test review decisions are unchanged.'
    case 'failed': return request.error ?? 'Review complete, but the run could not start.'
  }
}

export function PendingRunStartNotice({ pending, onRunStarted, onReview, onDismiss }: Props) {
  const live = useLiveResource('tests', pending.requestId, api.getRunStartRequest, { scope: pending.feature, reconcileMs: 5000, leaseMs: 15000 })
  const newest = useRef<RunStartRequest | null>(null)
  if (live.value && (!newest.current || live.value.version >= newest.current.version)) newest.current = live.value
  const request = newest.current
  const completed = useRef(false)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  useEffect(() => {
    if (!live.confirmed || !request || completed.current || !['started', 'queued'].includes(request.status) || !request.runId) return
    completed.current = true
    if (pending.mode !== 'boot') onRunStarted(request.runId)
    onDismiss(pending.requestId)
  }, [live.confirmed, request, pending.mode, pending.requestId, onRunStarted, onDismiss])
  const cancel = async (): Promise<void> => {
    setBusy(true)
    setActionError(null)
    try {
      await api.cancelRunStartRequest(pending.requestId)
      live.refresh()
    } catch (error) { setActionError(error instanceof Error ? error.message : 'Could not cancel the run request') }
    finally { setBusy(false) }
  }
  const done = request?.status === 'cancelled' || request?.status === 'failed'
  return (
    <div className="flex items-center gap-3 border-b border-default bg-surface px-4 py-2 text-xs" role="status">
      <div className="min-w-0 flex-1">
        <span className="font-mono text-primary">{pending.feature}</span>{' · '}
        <span className="text-secondary">{request ? requestMessage(request) : 'Checking your pending run request…'}</span>
        {(live.error || actionError) && <p className="mt-1 text-danger">{actionError ?? `Connection interrupted. Retrying automatically. ${live.error}`}</p>}
      </div>
      {request?.status === 'awaiting-review' && <button type="button" className="cl-button px-2 py-1" onClick={() => onReview(request.feature, request.review.runId)}>Review test changes</button>}
      {request?.owner.kind === 'internal' && ['awaiting-review', 'ready'].includes(request.status) && <button type="button" className="cl-button px-2 py-1" disabled={busy} onClick={() => { void cancel() }}>{busy ? 'Cancelling…' : 'Cancel run request'}</button>}
      {done && <button type="button" className="cl-button px-2 py-1" onClick={() => onDismiss(pending.requestId)}>Dismiss</button>}
    </div>
  )
}
