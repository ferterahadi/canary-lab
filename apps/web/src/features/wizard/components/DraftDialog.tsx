import { useEffect, useRef, useState } from 'react'
import { Modal } from '@/shared/ui/atoms'
import { ExternalDraftAgentPanel } from '@/features/runs'
import { isActiveWizardTask, useWizardDrafts } from '../state/WizardDraftContext'

// The routed home for a live external authoring draft (?dialog=draft&draft=<id>).
// An `authoring` activity row (Flights pill) is always an external MCP agent
// drafting a feature's specs; clicking it opens THIS dialog — the live agent
// session (ExternalDraftAgentPanel) plus the cleanup control. Before this the
// row dead-ended (it routed to the flights picker it was already in), and no
// draft surface was mounted at all.
//
// Open-state is owned by nav (App's `draftFor`, routed) — this component reads
// the draft record from the WizardDraftContext's live WS-fed list, so a cold
// load / refresh on the URL rehydrates it (the provider lists drafts on mount).
export function DraftDialog({ draftId, onClose }: { draftId: string; onClose: () => void }) {
  const { drafts, refreshDraft, deleteTask } = useWizardDrafts()
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  // A definitive miss from the server (404 / rejected) — distinct from "not
  // listed yet" on a cold deep-link, where drafts is briefly empty before the
  // provider's initial list resolves. Only a confirmed miss should close.
  const [gone, setGone] = useState(false)

  // Pull the latest on open (cold load / deep link); the context's WS keeps it
  // fresh after that. A null result means the draft truly doesn't exist.
  useEffect(() => {
    let alive = true
    void refreshDraft(draftId).then((d) => { if (alive && !d) setGone(true) })
    return () => { alive = false }
  }, [draftId, refreshDraft])

  const draft = drafts.find((d) => d.draftId === draftId) ?? null
  const seen = useRef(false)
  useEffect(() => { if (draft) seen.current = true }, [draft])

  // Close only once we KNOW there's nothing to show: the initial probe missed,
  // or a draft we were showing was deleted out from under us (WS `draft-deleted`
  // / our own discard). Never close merely because the list hasn't loaded yet.
  useEffect(() => {
    if ((gone || seen.current) && !draft && !busy) onClose()
  }, [gone, draft, busy, onClose])

  if (!draft) return null

  const active = isActiveWizardTask(draft.status)
  const stageView = draft.status === 'planning' ? 'planning' : 'generating'

  const discard = (): void => {
    setBusy(true)
    // deleteTask cancels an in-flight generation first, then deletes the record.
    deleteTask(draftId).finally(() => { setBusy(false); onClose() })
  }

  return (
    <Modal
      open
      onClose={onClose}
      width={560}
      icon={
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 20h9" />
          <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
        </svg>
      }
      title={draft.featureName || 'Authoring draft'}
      description="An external agent is authoring this feature's tests. Follow it in its own window; discard here to clean it up."
      headerActions={
        confirming ? (
          <button
            type="button"
            data-testid="draft-discard-confirm"
            disabled={busy}
            onClick={discard}
            className="cl-button px-2.5 py-1 text-xs"
            style={{ color: 'var(--danger)' }}
          >
            {busy ? 'Discarding…' : 'Really discard?'}
          </button>
        ) : (
          <button
            type="button"
            data-testid="draft-discard"
            onClick={() => setConfirming(true)}
            className="cl-button px-2.5 py-1 text-xs"
            title={active
              ? 'Stop the authoring agent and delete this draft'
              : 'Delete this draft'}
          >
            Discard draft
          </button>
        )
      }
    >
      <div className="flex min-h-[260px] flex-col p-4">
        <ExternalDraftAgentPanel draft={draft} stageView={stageView} />
      </div>
    </Modal>
  )
}
