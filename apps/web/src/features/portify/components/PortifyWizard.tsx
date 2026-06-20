import { useCallback, useEffect, useRef, useState } from 'react'
import * as api from '../../../shared/api/client'
import type { PortifyIndexEntry, PortifyManifest, PortifyStatus } from '../../../shared/api/client'
import { useActivePortify } from '../state/PortifyContext'
import { AgentSessionView } from '../../agent-sessions/components/AgentSessionView'
import { CopyButton } from '../../../shared/ui/CopyButton'

// Guided port-ification: an agent rewrites the feature's apps to use injectable
// ports, proven by a concurrent double-boot, ending when the user SAVES the
// verified edits as the feature's ephemeral overlay (a captured patch under
// features/<feature>/portify/). Nothing is committed or merged — at run time
// the overlay is applied into a per-run worktree and reverse-applied at
// teardown. Full-screen overlay mirroring the benchmark window; auto-polls.

const STEPS: { key: string; label: string; sub: string }[] = [
  { key: 'plan', label: 'Plan', sub: 'what changes' },
  { key: 'exercise', label: 'Exercise', sub: 'agent + verify' },
  { key: 'review', label: 'Review', sub: 'diff + proof' },
  { key: 'save', label: 'Save', sub: 'as overlay' },
]

function stepIndexFor(phase: 'plan' | PortifyStatus): number {
  switch (phase) {
    case 'plan': return 0
    case 'planning':
    case 'editing':
    case 'verifying': return 1
    case 'ready-to-save':
    case 'failed': return 2
    case 'saved': return 3
    default: return 1
  }
}

const STATUS_LABEL: Record<PortifyStatus, string> = {
  planning: 'Setting up scratch worktree…',
  editing: 'Agent is rewriting ports…',
  verifying: 'Booting twice on different ports…',
  'ready-to-save': 'Verified — ready to save',
  saved: 'Saved — boots concurrently from now on',
  failed: 'Could not make it work',
  aborted: 'Cancelled',
}

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
        if (isTerminalOrParked(next.status)) stopPolling()
      } catch { /* transient */ }
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
  // → saved) and discards the scratch worktree. Advance to the Save step.
  const save = async () => {
    if (!workflowId) return
    setBusy(true); setError(null)
    try {
      const next = await api.savePortify(workflowId)
      setM(next)
      setViewStep(3)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
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
          {isActive && (
            <button
              type="button"
              onClick={() => setConfirmLeave(true)}
              title="Discard this workflow — drops the scratch branch + worktree and restores the config"
              style={{ background: 'transparent', border: '1px solid rgba(251,113,133,0.4)', borderRadius: 'var(--radius-md)', color: 'rgb(251,113,133)', fontSize: 12, padding: '6px 12px', cursor: 'pointer' }}
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
          {workflowId && !m && (
            <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>Loading…</div>
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
          {workflowId && m && navigable && effectiveStep === 2 && (
            <ReviewScreen
              m={m}
              busy={busy}
              saved={isSaved(status)}
              onSave={save}
              onRequestChanges={() => setFeedbackOpen(true)}
              onViewSave={() => setViewStep(3)}
            />
          )}
          {workflowId && m && navigable && effectiveStep === 3 && (
            <SaveScreen m={m} onDone={onSaved} />
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
        <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'grid', placeItems: 'center', zIndex: 90 }}>
          <div style={{ width: 'min(420px, 92%)', background: 'var(--bg-surface)', border: '1px solid var(--border-default)', borderRadius: 'var(--radius-lg)', padding: 20 }}>
            <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 8 }}>Discard this workflow?</div>
            <div style={{ fontSize: 12.5, color: 'var(--text-muted)', lineHeight: 1.6, marginBottom: 16 }}>
              The scratch branch and worktree will be discarded and the feature config restored. Nothing is saved. To keep it running instead, choose <b style={{ color: 'var(--text-secondary)' }}>Keep running</b> — it stays in the top-bar Portify pill.
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button type="button" onClick={() => setConfirmLeave(false)} style={ghostBtn}>Keep running</button>
              <button type="button" onClick={discard} style={{ ...ghostBtn, color: 'rgb(251,113,133)', borderColor: 'rgba(251,113,133,0.4)' }}>Discard</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/** Status reached a point where polling stops (parked for the user or terminal). */
function isTerminalOrParked(s: PortifyStatus): boolean {
  return s === 'ready-to-save' || s === 'saved' || s === 'failed' || s === 'aborted'
}

/** The saved terminal state. */
function isSaved(s: PortifyStatus | undefined): boolean {
  return s === 'saved'
}

/** Review reached → stepper navigation is enabled. */
function isNavigable(s: PortifyStatus | undefined): boolean {
  return s === 'ready-to-save' || s === 'saved'
}

const ghostBtn: React.CSSProperties = {
  padding: '8px 14px', background: 'transparent', border: '1px solid var(--border-default)',
  borderRadius: 'var(--radius-md)', color: 'var(--text-secondary)', fontSize: 12, cursor: 'pointer',
}

function Stepper({
  current,
  reachedMax,
  saved,
  navigable,
  onStep,
}: {
  /** The step currently being viewed (gets the accent highlight). */
  current: number
  /** Furthest step the workflow itself has reached (status-derived). */
  reachedMax: number
  /** Whether the overlay has been saved (✓ on the Save step). */
  saved: boolean
  /** Whether step navigation is enabled (Review reached). */
  navigable: boolean
  onStep: (i: number) => void
}) {
  // A step is clickable once Review is reached, for any reached step except
  // Plan (the pre-start screen has no destination for an existing run).
  const isClickable = (i: number): boolean => navigable && i >= 1 && i <= reachedMax
  const SAVE_STEP = 3
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 0, padding: '14px 20px', borderBottom: '1px solid var(--border-default)' }}>
      {STEPS.map((s, i) => {
        const reached = i <= reachedMax
        const isCurrent = i === current
        const clickable = isClickable(i)
        const showSavedTick = saved && i === SAVE_STEP
        const circleColor = showSavedTick ? 'rgb(52,211,153)' : isCurrent || reached ? 'var(--accent)' : 'var(--text-muted)'
        const inner = (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, opacity: reached ? 1 : 0.45 }}>
            <span style={{
              width: 20, height: 20, borderRadius: 9999, display: 'grid', placeItems: 'center', fontSize: 11, fontWeight: 700,
              border: `2px solid ${showSavedTick ? 'rgb(52,211,153)' : isCurrent || reached ? 'var(--accent)' : 'var(--border-default)'}`,
              color: circleColor,
              background: isCurrent ? 'color-mix(in srgb, var(--accent) 14%, transparent)' : 'transparent',
            }}>{showSavedTick ? '✓' : i + 1}</span>
            <span style={{ fontSize: 12 }}>
              <b style={{ color: isCurrent ? 'var(--accent)' : 'var(--text-primary)' }}>{s.label}</b>
              <span style={{ color: 'var(--text-muted)', marginLeft: 6 }}>
                {showSavedTick ? 'saved ✓' : s.sub}
              </span>
            </span>
          </div>
        )
        return (
          <div key={s.key} style={{ display: 'flex', alignItems: 'center' }}>
            {clickable ? (
              <button
                type="button"
                onClick={() => onStep(i)}
                title={`Go to ${s.label}`}
                aria-current={isCurrent ? 'step' : undefined}
                style={{ background: 'transparent', border: 'none', padding: 0, cursor: 'pointer' }}
              >
                {inner}
              </button>
            ) : (
              inner
            )}
            {i < STEPS.length - 1 && <span style={{ width: 40, height: 2, background: 'var(--border-default)', margin: '0 12px' }} />}
          </div>
        )
      })}
    </div>
  )
}

// Shown instead of the Plan screen when another port-ification is already in
// flight (one runs at a time). Rather than let Start fail with an error, we gate
// the page and route the user straight to the running workflow.
function BlockedScreen({ active, onOpen, onClose }: { active: PortifyIndexEntry; onOpen: () => void; onClose: () => void }) {
  return (
    <div style={{ minHeight: 'calc(100dvh - 200px)', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
      <div style={{ width: 'min(520px, 100%)', margin: '0 auto', textAlign: 'center' }}>
        <div style={{ fontSize: 34, marginBottom: 14, opacity: 0.9 }}>🔌</div>
        <h2 style={{ fontSize: 21, fontWeight: 600, letterSpacing: '-0.01em', margin: '0 0 12px' }}>
          A port-ification is already running
        </h2>
        <p style={{ fontSize: 14, color: 'var(--text-secondary)', lineHeight: 1.65, margin: '0 0 6px' }}>
          Only one workflow runs at a time. <b style={{ color: 'var(--text-primary)' }}>{active.feature}</b> is in progress
          {' '}— <span style={{ color: 'var(--accent)' }}>{STATUS_LABEL[active.status]}</span>.
        </p>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.6, margin: '0 0 26px' }}>
          Finish or cancel it before starting another.
        </p>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap' }}>
          <button type="button" className="cl-button-primary" onClick={onOpen} style={{ padding: '10px 20px' }}>
            Open {active.feature} →
          </button>
          <button type="button" onClick={onClose} style={{ ...ghostBtn, padding: '10px 18px' }}>Close</button>
        </div>
      </div>
    </div>
  )
}

// Bottom-anchored, dismissable error banner for the full-screen wizard.
function ErrorBanner({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <div
      role="alert"
      style={{
        position: 'absolute', left: '50%', bottom: 24, transform: 'translateX(-50%)',
        maxWidth: 'min(560px, calc(100% - 40px))',
        display: 'flex', alignItems: 'flex-start', gap: 10,
        padding: '11px 12px 11px 14px', borderRadius: 'var(--radius-md)',
        background: 'var(--bg-surface)', border: '1px solid rgba(251,113,133,0.45)',
        color: 'rgb(251,113,133)', fontSize: 12.5, lineHeight: 1.5,
        boxShadow: '0 10px 34px rgba(0,0,0,0.4)', zIndex: 70,
      }}
    >
      <span aria-hidden="true" style={{ marginTop: 1 }}>⚠</span>
      <span style={{ flex: 1, minWidth: 0 }}>{message}</span>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss error"
        style={{ background: 'transparent', border: 'none', color: 'rgb(251,113,133)', cursor: 'pointer', fontSize: 13, lineHeight: 1, padding: '0 2px', flexShrink: 0 }}
      >
        ✕
      </button>
    </div>
  )
}

function PlanScreen({ feature, agent, busy, onStart }: { feature: string; agent: string; busy: boolean; onStart: () => void }) {
  const guarantees: React.ReactNode[] = [
    <>Saving captures the edits as an <b style={{ color: 'var(--text-secondary)' }}>ephemeral overlay</b> — your product repo is never modified.</>,
    <>On every run the overlay is applied into a per-run worktree and reverse-applied at teardown.</>,
    <>Test files are never modified.</>,
    <>Nothing is saved until you approve the verified diff.</>,
  ]
  // Fullscreen overlay → a centered reading column that starts near the top.
  // Don't vertically center: this screen is content-tall (intro + guarantees +
  // CTA), so centering floats the Start button with a dead gap beneath it.
  // Horizontal `margin: 0 auto` still lets it own the width.
  return (
    <div style={{ width: 'min(600px, 100%)', margin: '0 auto', paddingTop: 40 }}>
        <div style={{ fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '.5px', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontWeight: 600, marginBottom: 12 }}>
          Guided port-ification
        </div>
        <h2 style={{ fontSize: 22, fontWeight: 600, letterSpacing: '-0.01em', margin: '0 0 14px' }}>What will happen</h2>
        <p style={{ fontSize: 14, color: 'var(--text-secondary)', lineHeight: 1.65, margin: '0 0 10px' }}>
          The <b style={{ color: 'var(--text-primary)' }}>{agent}</b> agent edits <b style={{ color: 'var(--text-primary)' }}>{feature}</b> in an isolated scratch worktree so each app reads its listen port from an injected env var, and declares matching <code style={mono}>ports</code> slots in the feature config.
        </p>
        <p style={{ fontSize: 14, color: 'var(--text-secondary)', lineHeight: 1.65, margin: '0 0 24px' }}>
          The harness then boots the stack <b style={{ color: 'var(--text-primary)' }}>twice at once on different ports</b> and requires both to pass health checks — proof the rewrite works. You review the diff and save it.
        </p>

        <div style={{ border: '1px solid var(--border-default)', borderRadius: 'var(--radius-lg)', background: 'var(--bg-surface)', overflow: 'hidden', marginBottom: 26 }}>
          <div style={{ fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '.5px', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontWeight: 600, padding: '11px 16px', borderBottom: '1px solid var(--border-subtle)' }}>
            Guarantees
          </div>
          {guarantees.map((node, i) => (
            <div
              key={i}
              style={{
                display: 'grid', gridTemplateColumns: 'auto 1fr', gap: 10, alignItems: 'start',
                padding: '10px 16px', fontSize: 13, lineHeight: 1.55, color: 'var(--text-muted)',
                borderTop: i === 0 ? 'none' : '1px solid var(--border-subtle)',
              }}
            >
              <span style={{ color: 'var(--success)', fontSize: 12, marginTop: 2 }}>✓</span>
              <span>{node}</span>
            </div>
          ))}
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button type="button" className="cl-button-primary" disabled={busy} onClick={onStart} style={{ padding: '10px 20px' }}>
            {busy ? 'Starting…' : 'Start ▶'}
          </button>
        </div>
    </div>
  )
}

function ExerciseScreen({ m, live }: { m: PortifyManifest; live: boolean }) {
  // When viewed after the fact (live=false), every phase reads as done.
  const settled = !live || isNavigable(m.status)
  return (
    <div>
      <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 4 }}>{live ? 'Running the exercise' : 'The exercise'}</div>
      <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginBottom: 18 }}>
        Attempt {Math.max(1, m.attempt)} of {m.maxAttempts}
      </div>
      <div style={{ border: '1px solid var(--border-default)', borderRadius: 'var(--radius-lg)', overflow: 'hidden' }}>
        <Phase done label="Scratch worktree created" active={live && m.status === 'planning'} />
        <Phase done={settled || m.status === 'verifying'} active={live && m.status === 'editing'} label="Agent rewriting ports (source + config)" />
        <Phase done={settled} active={live && m.status === 'verifying'} label="Booting twice on different ports + health checks" />
      </div>
      <div style={{ fontSize: 12.5, color: 'var(--accent)', marginTop: 14 }}>{STATUS_LABEL[m.status]}</div>
      {live && m.verification && !m.verification.ok && m.verification.failureDetail && (
        <div style={{ marginTop: 12, fontSize: 11.5, fontFamily: 'var(--font-mono)', color: 'rgb(251,191,36)', background: 'var(--bg-base)', border: '1px solid var(--border-default)', borderRadius: 'var(--radius-md)', padding: '10px 12px', whiteSpace: 'pre-wrap' }}>
          Last attempt failed — retrying:{'\n'}{m.verification.failureDetail}
        </div>
      )}
      <div style={{ marginTop: 18 }}>
        <div style={{ fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '.4px', color: 'var(--text-muted)', fontWeight: 600, marginBottom: 8 }}>
          Agent
        </div>
        <div style={{ height: 360, border: '1px solid var(--border-default)', borderRadius: 'var(--radius-lg)', overflow: 'hidden' }}>
          <AgentSessionView source={{ kind: 'portify', workflowId: m.workflowId, live }} />
        </div>
      </div>
    </div>
  )
}

function Phase({ label, active, done }: { label: string; active?: boolean; done?: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '11px 14px', borderTop: '1px solid var(--border-default)' }}>
      <span style={{ fontSize: 13, color: done ? 'rgb(52,211,153)' : active ? 'var(--accent)' : 'var(--text-muted)' }}>
        {done ? '✓' : active ? '●' : '○'}
      </span>
      <span style={{ fontSize: 13, color: done || active ? 'var(--text-primary)' : 'var(--text-muted)' }}>{label}</span>
    </div>
  )
}

function VerificationBadge({ m }: { m: PortifyManifest }) {
  const insts = m.verification?.instances ?? []
  if (insts.length < 2 || !m.verification?.ok) return null
  const fmt = (p: Record<string, number>) => Object.entries(p).map(([k, v]) => `${k}:${v}`).join(' ')
  return (
    <div style={{ fontSize: 12, fontFamily: 'var(--font-mono)', color: 'rgb(52,211,153)', background: 'rgba(52,211,153,0.1)', border: '1px solid rgba(52,211,153,0.3)', borderRadius: 'var(--radius-md)', padding: '8px 11px', marginBottom: 14 }}>
      ✓ Booted twice — {fmt(insts[0].ports)} and {fmt(insts[1].ports)} — both healthy
    </div>
  )
}

function ReviewScreen({ m, busy, saved, onSave, onRequestChanges, onViewSave }: { m: PortifyManifest; busy: boolean; saved: boolean; onSave: () => void; onRequestChanges: () => void; onViewSave: () => void }) {
  const rounds = m.feedbackRounds ?? 0
  // At ready-to-save verification is always set; a prior revise round may have
  // left it failed — in that case the diff isn't proven and can't be saved.
  const proven = m.verification?.ok === true
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 12 }}>
        <div style={{ fontSize: 16, fontWeight: 600 }}>{saved ? 'Review' : 'Review & save'}</div>
        {rounds > 0 && (
          <span style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>
            revision {rounds}
          </span>
        )}
      </div>
      {proven ? <VerificationBadge m={m} /> : <RevisionFailedBanner m={m} />}
      {/* The scratch worktree is gone after save — review is read-only. */}
      {!saved && <ReviewLocally m={m} />}
      <DiffView diff={m.diff ?? ''} />
      {saved ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 16, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12.5, color: 'rgb(52,211,153)', fontWeight: 600 }}>✓ Saved as overlay</span>
          <button
            type="button"
            onClick={onViewSave}
            style={{ marginLeft: 'auto', padding: '8px 14px', fontSize: 12.5, fontWeight: 600, borderRadius: 'var(--radius-md)', background: 'transparent', border: '1px solid var(--accent)', color: 'var(--accent)', cursor: 'pointer', whiteSpace: 'nowrap' }}
          >
            View save details →
          </button>
        </div>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 12, marginTop: 16 }}>
          <button
            type="button"
            onClick={onRequestChanges}
            disabled={busy}
            title="Send the agent feedback — it resumes its session and re-verifies"
            style={{
              padding: '9px 16px', fontSize: 12.5, fontWeight: 600, borderRadius: 'var(--radius-md)', whiteSpace: 'nowrap',
              background: 'transparent', border: '1px solid var(--accent)', color: 'var(--accent)',
              cursor: busy ? 'not-allowed' : 'pointer', opacity: busy ? 0.5 : 1,
            }}
          >
            Request changes
          </button>
          <button
            type="button"
            className="cl-button-primary"
            disabled={busy || !proven}
            onClick={onSave}
            title={proven ? undefined : 'The latest changes did not pass verification — request changes to fix them first'}
            style={{ padding: '9px 16px', opacity: proven ? 1 : 0.5, cursor: proven && !busy ? 'pointer' : 'not-allowed' }}
          >
            {busy ? 'Saving…' : 'Save overlay'}
          </button>
        </div>
      )}
    </div>
  )
}

// "Not ready yet" path: point the user at the on-disk scratch worktree so they
// can open it in their own editor and review the full change before saving. The
// workflow parks at ready-to-save indefinitely; hand-edits in the worktree are
// captured into the saved overlay.
function ReviewLocally({ m }: { m: PortifyManifest }) {
  const trees = m.repos.filter((r) => r.worktreePath)
  if (trees.length === 0) return null
  return (
    <div style={{ marginBottom: 14, border: '1px solid var(--border-default)', borderRadius: 'var(--radius-md)', background: 'var(--bg-surface)', padding: '11px 13px' }}>
      <div style={{ fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '.4px', color: 'var(--text-muted)', fontWeight: 600, marginBottom: 8 }}>
        Review locally
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.55, marginBottom: 10 }}>
        Not ready? Open the scratch worktree in your editor to review the full change first — it stays here until you save. Hand-edits in the worktree are captured into the overlay.
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
        {trees.map((r) => (
          <div key={r.name} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 11.5, color: 'var(--text-secondary)', flexShrink: 0 }}>{r.name}</span>
            <code style={{ ...mono, flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.worktreePath}</code>
            <CopyButton value={r.worktreePath!} label="Copy path" style={{ flexShrink: 0 }} />
          </div>
        ))}
      </div>
    </div>
  )
}

// Amber warning shown on the review screen when the most recent revise pass
// broke the double-boot (or touched tests) — mirrors the retry banner styling.
function RevisionFailedBanner({ m }: { m: PortifyManifest }) {
  return (
    <div style={{ fontSize: 11.5, fontFamily: 'var(--font-mono)', color: 'rgb(251,191,36)', background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.3)', borderRadius: 'var(--radius-md)', padding: '10px 12px', marginBottom: 14, whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>
      ⚠ Your last change didn't pass the double-boot — fix it with “Request changes” before saving.
      {m.verification?.failureDetail ? `\n\n${m.verification.failureDetail}` : ''}
      {m.error ? `\n\n${m.error}` : ''}
    </div>
  )
}

// Modal composer to send the agent review feedback. Autofocuses; Cmd/Ctrl+Enter
// submits; Escape / backdrop / Cancel closes (unless a send is in flight).
function FeedbackModal({ busy, onSend, onClose }: { busy: boolean; onSend: (feedback: string) => void; onClose: () => void }) {
  const [text, setText] = useState('')
  const taRef = useRef<HTMLTextAreaElement | null>(null)
  const trimmed = text.trim()
  useEffect(() => { taRef.current?.focus() }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape' && !busy) onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [busy, onClose])
  const send = (): void => { if (trimmed && !busy) onSend(trimmed) }
  return (
    <div
      style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'grid', placeItems: 'center', zIndex: 90 }}
      onClick={() => { if (!busy) onClose() }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Ask the agent for changes"
        style={{ width: 'min(560px, 92%)', background: 'var(--bg-surface)', border: '1px solid var(--border-default)', borderRadius: 'var(--radius-lg)', padding: 20 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 6 }}>Ask the agent for changes</div>
        <div style={{ fontSize: 12.5, color: 'var(--text-muted)', lineHeight: 1.6, marginBottom: 12 }}>
          The agent resumes where it left off, applies your feedback, and re-runs the double-boot before it's ready to save again.
        </div>
        <textarea
          ref={taRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); send() } }}
          placeholder={'e.g. “use PORT instead of GATEWAY_PORT”, or “also expose the bull-dashboard slot”'}
          rows={4}
          disabled={busy}
          style={{
            width: '100%', resize: 'vertical', boxSizing: 'border-box',
            fontSize: 13, lineHeight: 1.55, fontFamily: 'var(--font-sans)', color: 'var(--text-primary)',
            background: 'var(--bg-base)', border: '1px solid var(--border-default)', borderRadius: 'var(--radius-md)',
            padding: '9px 11px', outline: 'none',
          }}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 14 }}>
          <span style={{ marginRight: 'auto', fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>⌘↵ to send</span>
          <button type="button" onClick={() => { if (!busy) onClose() }} disabled={busy} style={ghostBtn}>Cancel</button>
          <button
            type="button"
            className="cl-button-primary"
            onClick={send}
            disabled={busy || !trimmed}
            style={{ padding: '8px 16px', opacity: busy || !trimmed ? 0.55 : 1, cursor: busy || !trimmed ? 'not-allowed' : 'pointer' }}
          >
            {busy ? 'Resuming agent…' : 'Send & re-verify'}
          </button>
        </div>
      </div>
    </div>
  )
}

// The wizard's last step: the overlay is saved. Nothing to merge — the feature
// now boots concurrently on every run, applying the overlay into a per-run
// worktree and reverse-applying it at teardown. The product repo is untouched.
function SaveScreen({ m, onDone }: { m: PortifyManifest; onDone: () => void }) {
  const overlayPath = `features/${m.feature}/portify/`
  return (
    <div>
      <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 8, color: 'rgb(52,211,153)' }}>✓ Saved as overlay</div>
      <p style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.6, marginBottom: 14 }}>
        The verified port rewrite is captured as an ephemeral overlay. <b style={{ color: 'var(--text-secondary)' }}>{m.feature}</b> now boots concurrently — parallel runs and benchmark arms get distinct ports — and your product repo is never modified. On every run the overlay is applied into a per-run worktree before boot and reverse-applied at teardown.
      </p>
      <div style={{ border: '1px solid var(--border-default)', borderRadius: 'var(--radius-md)', background: 'var(--bg-surface)', padding: '13px 15px', marginBottom: 18 }}>
        <div style={{ fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '.4px', color: 'var(--text-muted)', fontWeight: 600, marginBottom: 8 }}>
          Overlay
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
          <code style={{ ...mono, flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{overlayPath}</code>
          <CopyButton value={overlayPath} label="Copy path" style={{ flexShrink: 0 }} />
        </div>
        {m.repos.map((r) => (
          <div key={r.name} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)', padding: '3px 0' }}>
            <span style={{ color: 'rgb(52,211,153)' }}>✓</span>
            <span>{r.name}</span>
          </div>
        ))}
      </div>
      <button type="button" className="cl-button-primary" onClick={onDone} style={{ padding: '9px 16px' }}>Done</button>
    </div>
  )
}

function FailedScreen({ m, onClose }: { m: PortifyManifest; onClose: () => void }) {
  // An environment failure (e.g. the DB is down) isn't a fault in the port
  // rewrite — title it so the user knows to fix the env and re-run, not to
  // expect a different agent attempt.
  const title =
    m.status === 'aborted'
      ? 'Cancelled'
      : m.verification?.notPortFixable
        ? 'Stack could not boot (environment)'
        : 'Could not make it work'
  return (
    <div>
      <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 8, color: 'rgb(251,113,133)' }}>
        {title}
      </div>
      {m.error && <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 12 }}>{m.error}</p>}
      {m.verification?.failureDetail && (
        <div style={{ fontSize: 11.5, fontFamily: 'var(--font-mono)', color: 'rgb(251,191,36)', background: 'var(--bg-base)', border: '1px solid var(--border-default)', borderRadius: 'var(--radius-md)', padding: '10px 12px', whiteSpace: 'pre-wrap', marginBottom: 14 }}>
          {m.verification.failureDetail}
        </div>
      )}
      {m.diff && <DiffView diff={m.diff} />}
      <button type="button" onClick={onClose} style={{ ...ghostBtn, marginTop: 16 }}>Close</button>
    </div>
  )
}

function DiffView({ diff }: { diff: string }) {
  if (!diff.trim()) return <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>(no diff captured)</div>
  return (
    <pre style={{
      fontSize: 11.5, fontFamily: 'var(--font-mono)', lineHeight: 1.5, color: 'var(--text-secondary)',
      background: 'var(--bg-base)', border: '1px solid var(--border-default)', borderRadius: 'var(--radius-md)',
      padding: '12px 14px', maxHeight: 360, overflow: 'auto', whiteSpace: 'pre', margin: 0,
    }}>
      {diff.split('\n').map((line, i) => (
        <div key={i} style={{ color: lineColor(line) }}>{line || ' '}</div>
      ))}
    </pre>
  )
}

function lineColor(line: string): string {
  if (line.startsWith('# ')) return 'var(--accent)'
  if (line.startsWith('+') && !line.startsWith('+++')) return 'rgb(52,211,153)'
  if (line.startsWith('-') && !line.startsWith('---')) return 'rgb(251,113,133)'
  if (line.startsWith('@@')) return 'var(--text-muted)'
  return 'var(--text-secondary)'
}

const mono: React.CSSProperties = { fontFamily: 'var(--font-mono)', fontSize: 12, background: 'var(--bg-base)', border: '1px solid var(--border-default)', borderRadius: 4, padding: '1px 5px' }
