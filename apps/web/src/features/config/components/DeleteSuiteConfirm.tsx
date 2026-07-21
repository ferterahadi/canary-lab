import { useState } from 'react'
import { ConfirmModal } from './atoms'
import * as api from '../../../shared/api/client'

/** R76: THE suite deletion confirm — one home (per the reuse rule), opened
 *  from Advanced setup's trash and the flight page's ⋯ menu. One deletion
 *  concept: the suite folder (config, tests, envsets, docs) AND its flight
 *  history go together — the server enforces both sides (records removed with
 *  the folder; an active flight 409s the whole thing). Type-name-to-confirm. */
export function DeleteSuiteConfirm({
  feature,
  open,
  onCancel,
  onDeleted,
}: {
  feature: string
  open: boolean
  onCancel: () => void
  /** Fired after a successful delete — navigate away from the dead surface. */
  onDeleted: () => void
}) {
  const [confirmName, setConfirmName] = useState('')
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)

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
      await api.deleteFeature(feature, confirmName)
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
      title="Delete suite"
      message={
        <div className="space-y-3">
          <p>
            This permanently deletes the suite <code style={{ fontFamily: 'var(--font-mono)' }}>{feature}</code> —
            its folder under features/ (config, Playwright tests, envsets, docs) and its flight history.
          </p>
          <p style={{ color: 'var(--danger)' }}>
            This cannot be undone. Type the suite name to confirm.
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
      confirmLabel="Delete suite"
      variant="danger"
      busy={deleting}
      confirmDisabled={confirmName !== feature}
      onCancel={cancel}
      onConfirm={() => { void confirm() }}
    />
  )
}
