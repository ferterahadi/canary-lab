import { useState } from 'react'
import * as api from '@/shared/api/client'
import { ConfirmModal } from '@/shared/ui/atoms'
import { EXTERNAL_WORK_COPY } from '../lib/external-work'

/** The one web-owned action while an external agent holds a Flight step.
 *  The external agent owns the checkpoint answer; this control only requests
 *  the serialized hand-off (or confirms the unsafe fallback after a request). */
export function FlightTakeoverAction({
  flightId,
  requested,
  onResponded,
  onError,
}: {
  flightId: string
  requested: boolean
  onResponded: () => void
  onError: (message: string | null) => void
}) {
  const [busy, setBusy] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)

  const mutate = (): void => {
    setBusy(true)
    onError(null)
    const call = requested ? api.forceFlightTakeover(flightId) : api.requestFlightTakeover(flightId)
    call
      .then(() => onResponded())
      .catch((err: unknown) => onError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false))
  }

  return (
    <>
      <button
        type="button"
        data-testid={requested ? 'flight-force-takeover' : 'flight-request-takeover'}
        disabled={busy}
        aria-haspopup="dialog"
        title={requested
          ? EXTERNAL_WORK_COPY.takeover.requestedLockTitle
          : EXTERNAL_WORK_COPY.takeover.availableBody}
        onClick={() => setConfirmOpen(true)}
        className="cl-button shrink-0 px-2.5 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-45"
        style={requested ? { color: 'var(--danger)' } : undefined}
      >
        {requested ? EXTERNAL_WORK_COPY.takeover.forceLabel : EXTERNAL_WORK_COPY.takeover.requestLabel}
      </button>
      <ConfirmModal
        open={confirmOpen}
        title={requested
          ? EXTERNAL_WORK_COPY.takeover.forceDialogTitle
          : EXTERNAL_WORK_COPY.takeover.requestDialogTitle}
        message={requested
          ? EXTERNAL_WORK_COPY.takeover.forceDialogMessage
          : EXTERNAL_WORK_COPY.takeover.requestDialogMessage}
        confirmLabel={requested ? 'Force takeover' : 'Request takeover'}
        variant={requested ? 'danger' : 'default'}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => {
          setConfirmOpen(false)
          mutate()
        }}
        busy={busy}
      />
    </>
  )
}
