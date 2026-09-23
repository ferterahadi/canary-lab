import { useState } from 'react'
import * as api from '@/shared/api/client'
import type { PortifyManifest } from '@/shared/api/client'
import { useInvalidation } from '@/shared/state/invalidation'
import { ConfirmModal } from '@/shared/ui/atoms'
import { usePortify } from '../state/PortifyContext'
import { FeedbackModal, ReviewScreen } from './PortifyScreens'

/** Actions for a standalone Portify workflow shown inside Flight's Parallel
 *  readiness stage. Conducted Flights keep using their checkpoint controls;
 *  this bridge keeps older independently-started work actionable after the
 *  full-screen Portify overlay stops being a navigation destination. */
export function PortifyWorkflowControls({
  manifest,
  onChanged,
}: {
  manifest: PortifyManifest
  onChanged: () => void
}) {
  const { loadPortify } = usePortify()
  const { invalidate } = useInvalidation()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [feedbackOpen, setFeedbackOpen] = useState(false)
  const [confirmCancel, setConfirmCancel] = useState(false)

  const refresh = async (): Promise<void> => {
    await loadPortify(manifest.workflowId)
    invalidate('ports')
    invalidate('repos')
    invalidate('flights')
    onChanged()
  }

  const save = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await api.savePortify(manifest.workflowId)
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const revise = async (feedback: string): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await api.revisePortify(manifest.workflowId, feedback)
      setFeedbackOpen(false)
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const cancel = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await api.cancelPortify(manifest.workflowId)
      setConfirmCancel(false)
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  if (manifest.status === 'ready-to-save') {
    return (
      <div data-testid="portify-workflow-review">
        <ReviewScreen
          m={manifest}
          busy={busy}
          saved={false}
          canRequestChanges={manifest.producer !== 'external'}
          onSave={() => { void save() }}
          onRequestChanges={() => setFeedbackOpen(true)}
          onDone={onChanged}
        />
        {error && <div role="alert" className="mt-3 cl-type-meta text-danger">{error}</div>}
        {feedbackOpen && (
          <FeedbackModal
            busy={busy}
            onSend={(feedback) => { void revise(feedback) }}
            onClose={() => setFeedbackOpen(false)}
          />
        )}
      </div>
    )
  }

  const cancellable = manifest.producer !== 'external'
    && (manifest.status === 'planning' || manifest.status === 'editing' || manifest.status === 'verifying')
  if (!cancellable) return null

  return (
    <div data-testid="portify-workflow-actions" className="flex items-center justify-between gap-3">
      <div className="cl-type-body text-muted">Port work is running here in Flight.</div>
      {/* `.cl-button` declares its own size and colour, so the `text-[11px]
          text-danger` that sat here never rendered; the stage's compact button
          geometry (Send to repair, Advanced setup) is what it should match. */}
      <button
        type="button"
        className="cl-button min-h-6 shrink-0 px-2 py-0.5"
        disabled={busy}
        onClick={() => setConfirmCancel(true)}
      >
        Cancel port work
      </button>
      {error && <div role="alert" className="cl-type-meta text-danger">{error}</div>}
      <ConfirmModal
        open={confirmCancel}
        title="Discard this port work?"
        message="This removes the scratch branch and worktree. The feature configuration stays unchanged."
        confirmLabel="Discard"
        variant="danger"
        busy={busy}
        onConfirm={() => { void cancel() }}
        onCancel={() => setConfirmCancel(false)}
      />
    </div>
  )
}
