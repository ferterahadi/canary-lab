import { useCallback, useEffect, useRef, useState } from 'react'
import * as api from '@/shared/api/client'
import type { PortifyIndexEntry, PortifyManifest } from '@/shared/api/client'
import { useActivePortify } from '../state/PortifyContext'
import { BlockedScreen, ErrorBanner, ExerciseScreen, FailedScreen, FeedbackModal, NotFoundScreen, PlanScreen, ReviewScreen, mono } from './PortifyScreens'
import { Stepper, ghostBtn, isNavigable, isSaved, isTerminalOrParked, stepIndexFor } from './PortifyStepper'

export function PortifyWizard({
  feature,
  agent = 'claude',
  workflowId: initialWorkflowId,
  onOpenActive,
  onClose,
  onSaved,
}: {
  /** New mode: the feature to port-ify (Plan screen → Start). */
  feature?: string
  agent?: 'claude' | 'codex'
  /** Revisit mode: reopen an in-flight workflow by id (skip the Plan screen). */
  workflowId?: string
  /** Jump to the already-running workflow (used by the blocked Plan screen). */
  onOpenActive?: (workflowId: string) => void
  onClose: () => void
  onSaved: () => void
}) {
  const activePortify = useActivePortify()
  const [workflowId, setWorkflowId] = useState<string | null>(initialWorkflowId ?? null)
  const [m, setM] = useState<PortifyManifest | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // The workflow's record was wiped (e.g. logs cleanup) but its history row
  // lingered — getPortify 404s. Surface that instead of hanging on "Loading…".
  const [notFound, setNotFound] = useState(false)
  const [confirmLeave, setConfirmLeave] = useState(false)
  const [feedbackOpen, setFeedbackOpen] = useState(false)
  // Bumped after a revise pass to restart the poller (status flips back to
  // editing, so polling — stopped at ready-to-save — must resume).
  const [pollNonce, setPollNonce] = useState(0)
  // Stepper navigation override: which step the user is *viewing*, when it
  // differs from the status-derived step. Null = follow status. Only honored
  // once Review is reached (ready-to-save / saved).
  const [viewStep, setViewStep] = useState<number | null>(null)
  const pollRef = useRef<number | null>(null)

  const stopPolling = useCallback(() => {
    if (pollRef.current != null) { window.clearInterval(pollRef.current); pollRef.current = null }
  }, [])

  // Poll the manifest while the workflow is in-flight.
  useEffect(() => {
    if (!workflowId) return
    const tick = async () => {
      try {
        const next = await api.getPortify(workflowId)
        setM(next)
        setNotFound(false)
        if (isTerminalOrParked(next.status)) stopPolling()
      } catch (e) {
        // A 404 is terminal, not transient: the record is gone, so stop polling
        // and show the not-found state. Any other error stays transient (retry).
        if (e instanceof api.ApiError && e.status === 404) { setNotFound(true); stopPolling() }
      }
    }
    void tick()
    pollRef.current = window.setInterval(tick, 1500)
    return stopPolling
  }, [workflowId, pollNonce, stopPolling])

  // Drop any stepper override whenever the run isn't in a navigable state
  // (active again after a revise, or terminal-failed) so live progress shows.
  useEffect(() => {
    if (!isNavigable(m?.status)) setViewStep(null)
  }, [m?.status])

  const start = async () => {
    if (!feature) return
    setBusy(true); setError(null)
    try {
      const { workflowId: id } = await api.startPortify({ feature, agent })
      setWorkflowId(id)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  // Save captures the verified edits as the feature's ephemeral overlay (status
  // → saved) and discards the scratch worktree, then closes the wizard outright.
  // onSaved unmounts us and refreshes the feature list / Ports tab, so there's
  // no in-place transition to a confirmation screen (which caused a layout shift
  // as the "Done" button appeared). The saved Review screen is still reachable
  // by revisiting the workflow from history.
  const save = async () => {
    if (!workflowId) return
    setBusy(true); setError(null)
    try {
      await api.savePortify(workflowId)
      stopPolling()
      onSaved()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  // Send review feedback: the agent resumes its session, the workflow flips
  // back to editing, and the poller (restarted via pollNonce) takes it through
  // verifying → ready-to-save again.
  const revise = async (feedback: string) => {
    if (!workflowId) return
    setBusy(true); setError(null)
    try {
      const next = await api.revisePortify(workflowId, feedback)
      setM(next)
      setFeedbackOpen(false)
      setPollNonce((n) => n + 1)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  // Minimize: just close the overlay. The workflow keeps running on the
  // server — reopen it from the GlobalStatusBar "Portify" pill (async/revisit).
  const minimize = () => {
    stopPolling()
    onClose()
  }

  // Discard: explicitly tear the workflow down (scratch worktree + branch) and
  // close. Only reachable via the destructive "Cancel" → "Discard" confirmation.
  const discard = async () => {
    stopPolling()
    if (workflowId && m && !isSaved(m.status)) {
      try { await api.cancelPortify(workflowId) } catch { /* best-effort */ }
    }
    onClose()
  }

  const status = m?.status
  // Port-ification is one-at-a-time. In Plan mode (this wizard hasn't started
  // its own workflow yet), another in-flight workflow blocks the Start screen
  // entirely — we route the user to the running one instead of letting Start
  // fail. Once this wizard owns a workflowId, it's the active one, so no block.
  const blockedBy: PortifyIndexEntry | null = !workflowId && activePortify ? activePortify : null
  // A workflow is "in flight" (cancellable / worth keeping alive) until it is
  // saved or terminal.
  const isActive = Boolean(workflowId) && status != null
    && !isSaved(status) && status !== 'failed' && status !== 'aborted'
  // statusStep = where the workflow's status puts it; effectiveStep = what the
  // user is viewing (status, or a stepper override once Review is reached).
  const statusStep = stepIndexFor(workflowId ? (status ?? 'planning') : 'plan')
  const navigable = isNavigable(status)
  const effectiveStep = navigable ? (viewStep ?? statusStep) : statusStep

  return (
    <div className="fixed inset-0 z-[80] flex flex-col" style={{ background: 'var(--bg-base)' }}>
      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 20px', borderBottom: '1px solid var(--border-default)' }}>
        <div style={{ fontWeight: 600, fontSize: 15 }}>
          Portify <span style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontSize: 13, marginLeft: 8 }}>{m?.feature ?? feature ?? ''}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {isActive && m?.producer !== 'external' && (
            <button
              type="button"
              onClick={() => setConfirmLeave(true)}
              title="Discard this workflow — drops the scratch branch + worktree and restores the config"
              style={{ background: 'transparent', border: '1px solid color-mix(in srgb, var(--danger) 45%, var(--border-default))', borderRadius: 'var(--radius-md)', color: 'var(--danger)', fontSize: 12, padding: '6px 12px', cursor: 'pointer' }}
            >
              Cancel
            </button>
          )}
          <button
            type="button"
            onClick={isActive ? minimize : discard}
            title={isActive
              ? 'Close — the workflow keeps running. Reopen it from the Portify pill in the top bar.'
              : 'Close — a failed/aborted run is cleaned up; a saved one keeps its overlay.'}
            style={{ background: 'transparent', border: '1px solid var(--border-default)', borderRadius: 'var(--radius-md)', color: 'var(--text-secondary)', fontSize: 12, padding: '6px 12px', cursor: 'pointer' }}
          >
            Close ✕
          </button>
        </div>
      </header>

      <Stepper
        current={workflowId ? effectiveStep : 0}
        reachedMax={workflowId ? statusStep : 0}
        saved={isSaved(status)}
        navigable={navigable}
        onStep={setViewStep}
      />

      <div style={{ flex: 1, overflow: 'auto', padding: '20px 22px 60px', display: 'flex', justifyContent: 'center', alignItems: 'flex-start' }}>
        <div style={{ width: 'min(820px, 100%)' }}>
          {!workflowId && blockedBy && (
            <BlockedScreen
              active={blockedBy}
              onOpen={() => onOpenActive?.(blockedBy.workflowId)}
              onClose={onClose}
            />
          )}
          {!workflowId && !blockedBy && feature && <PlanScreen feature={feature} agent={agent} busy={busy} onStart={start} />}
          {workflowId && !m && !notFound && (
            <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>Loading…</div>
          )}
          {workflowId && notFound && (
            <NotFoundScreen
              busy={busy}
              onRemove={async () => {
                setBusy(true)
                try { await api.removePortify(workflowId) } catch { /* best-effort */ }
                setBusy(false)
                onClose()
              }}
              onClose={onClose}
            />
          )}
          {/* Live, non-navigable states render straight from status. */}
          {workflowId && m && !navigable && (status === 'planning' || status === 'editing' || status === 'verifying') && (
            <ExerciseScreen m={m} live />
          )}
          {workflowId && m && !navigable && (status === 'failed' || status === 'aborted') && (
            <FailedScreen m={m} onClose={discard} />
          )}
          {/* Once Review is reached, the stepper drives which screen shows. */}
          {workflowId && m && navigable && effectiveStep === 1 && <ExerciseScreen m={m} live={false} />}
          {/* Review and Save are one screen and one stepper node: pre-save it's
              "Review & save" (diff + proof + actions); post-save it's the same
              diff + proof with the overlay confirmation folded in. */}
          {workflowId && m && navigable && effectiveStep === 2 && (
            <ReviewScreen
              m={m}
              busy={busy}
              saved={isSaved(status)}
              onSave={save}
              onRequestChanges={() => setFeedbackOpen(true)}
              onDone={onSaved}
            />
          )}
        </div>
      </div>

      {/* Errors anchor to the bottom of the wizard as a dismissable banner —
          always visible regardless of scroll, instead of trailing far below a
          vertically-centered screen where it reads as detached. */}
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}

      {feedbackOpen && (
        <FeedbackModal busy={busy} onSend={revise} onClose={() => setFeedbackOpen(false)} />
      )}

      {confirmLeave && (
        <div style={{ position: 'absolute', inset: 0, background: 'var(--overlay-backdrop)', display: 'grid', placeItems: 'center', zIndex: 90 }}>
          <div style={{ width: 'min(420px, 92%)', background: 'var(--bg-surface)', border: '1px solid var(--border-default)', borderRadius: 'var(--radius-lg)', padding: 20 }}>
            <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 8 }}>Discard this workflow?</div>
            <div style={{ fontSize: 12.5, color: 'var(--text-muted)', lineHeight: 1.6, marginBottom: 16 }}>
              The scratch branch and worktree will be discarded and the feature config restored. Nothing is saved. To keep it running instead, choose <b style={{ color: 'var(--text-secondary)' }}>Keep running</b> — it stays in the top-bar Portify pill.
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button type="button" onClick={() => setConfirmLeave(false)} style={ghostBtn}>Keep running</button>
              <button type="button" onClick={discard} style={{ ...ghostBtn, color: 'var(--danger)', borderColor: 'color-mix(in srgb, var(--danger) 45%, var(--border-default))' }}>Discard</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
