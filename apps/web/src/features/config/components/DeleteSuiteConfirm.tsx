import { useState } from 'react'
import { ConfirmModal } from '@/shared/ui/atoms'
import * as api from '@/shared/api/client'

/** R76: the one type-name destructive confirm, opened from Advanced setup and
 *  the flight page's ⋯ menu. A scaffolded suite removes its folder and history;
 *  a flight stopped before scaffold has no suite yet, so it removes its record. */
export function DeleteSuiteConfirm({
  feature,
  flightId,
  open,
  onCancel,
  onDeleted,
}: {
  feature: string
  /** A pre-scaffold record has no feature directory to delete. */
  flightId?: string
  open: boolean
  onCancel: () => void
  /** Fired after a successful deletion — navigate away from the dead surface. */
  onDeleted: () => void
}) {
  const [confirmName, setConfirmName] = useState('')
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const removingFlight = flightId !== undefined

  const cancel = (): void => {
    if (deleting) return
    setConfirmName('')
    setError(null)
    onCancel()
  }

  const confirm = async (): Promise<void> => {
    if (confirmName !== feature || deleting) return
    setDeleting(true)
    setError(null)
    try {
      if (flightId) await api.deleteFlight(flightId)
      else await api.deleteFeature(feature, confirmName)
      setDeleting(false)
      setConfirmName('')
      onDeleted()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Delete failed')
      setDeleting(false)
    }
  }

  return (
    <ConfirmModal
      open={open}
      title={removingFlight ? 'Remove flight' : 'Delete suite'}
      message={
        <div className="space-y-3">
          {removingFlight
            ? <p>
                This permanently removes the abandoned flight for <code style={{ fontFamily: 'var(--font-mono)' }}>{feature}</code>.
                It stopped before Suite setup, so no suite folder was created.
              </p>
            : <p>
                This permanently deletes the suite <code style={{ fontFamily: 'var(--font-mono)' }}>{feature}</code> —
                its folder under features/ (config, Playwright tests, envsets, docs) and its flight history.
              </p>}
          <p style={{ color: 'var(--danger)' }}>
            This cannot be undone. Type the {removingFlight ? 'planned suite' : 'suite'} name to confirm.
          </p>
          <input
            data-testid="delete-suite-confirm-name"
            value={confirmName}
            onChange={(e) => setConfirmName(e.target.value)}
            className="cl-input w-full rounded-md px-2 py-1.5 text-xs"
            style={{ fontFamily: 'var(--font-mono)' }}
            autoFocus
            placeholder={feature}
          />
          {error && <p style={{ color: 'var(--danger)' }}>{error}</p>}
        </div>
      }
      confirmLabel={removingFlight ? 'Remove flight' : 'Delete suite'}
      variant="danger"
      busy={deleting}
      confirmDisabled={confirmName !== feature}
      onCancel={cancel}
      onConfirm={() => { void confirm() }}
    />
  )
}
