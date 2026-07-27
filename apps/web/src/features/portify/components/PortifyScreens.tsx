import { useEffect, useRef, useState } from 'react'
import * as api from '@/shared/api/client'
import type { PortifyIndexEntry, PortifyManifest } from '@/shared/api/client'
import { AgentSessionView } from '@/shared/ui/AgentSessionView'
import { DiffView } from '@/shared/ui/DiffView'
import { ExternalPortifyPanel } from './ExternalPortifyPanel'
import { NoChangesNeeded, SavedOverlayPanel, VerificationBadge } from './SavedOverlayPanel'
import { STATUS_LABEL, ghostBtn, isNavigable } from './PortifyStepper'

// Shown instead of the Plan screen when another port-ification is already in
// flight (one runs at a time). Rather than let Start fail with an error, we gate
// the page and route the user straight to the running workflow.
export function BlockedScreen({ active, onOpen, onClose }: { active: PortifyIndexEntry; onOpen: () => void; onClose: () => void }) {
  return (
    <div style={{ minHeight: 'calc(100dvh - 200px)', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
      <div style={{ width: 'min(520px, 100%)', margin: '0 auto', textAlign: 'center' }}>
        <div style={{ fontSize: 24, marginBottom: 14, opacity: 0.9 }}>🔌</div>
        <h2 style={{ fontSize: 16, fontWeight: 600, letterSpacing: '-0.01em', margin: '0 0 12px' }}>
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

// The workflow's record was wiped but its history row lingered (getPortify
// 404). Tell the truth + offer to clear the dead row, instead of hanging on
// "Loading…". Remove tolerates the missing record server-side.
export function NotFoundScreen({ busy, onRemove, onClose }: { busy: boolean; onRemove: () => void; onClose: () => void }) {
  return (
    <div style={{ minHeight: 'calc(100dvh - 200px)', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
      <div style={{ width: 'min(520px, 100%)', margin: '0 auto', textAlign: 'center' }}>
        <div style={{ fontSize: 24, marginBottom: 14, opacity: 0.9 }}>🗑️</div>
        <h2 style={{ fontSize: 16, fontWeight: 600, letterSpacing: '-0.01em', margin: '0 0 12px' }}>
          This run’s data is no longer available
        </h2>
        <p style={{ fontSize: 14, color: 'var(--text-secondary)', lineHeight: 1.65, margin: '0 0 26px' }}>
          Its record was removed (a logs cleanup, or a manual delete), so there’s nothing left to open.
          You can clear the leftover history row.
        </p>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap' }}>
          <button type="button" className="cl-button-primary" onClick={onRemove} disabled={busy} style={{ padding: '10px 20px' }}>
            {busy ? 'Removing…' : 'Remove from history'}
          </button>
          <button type="button" onClick={onClose} style={{ ...ghostBtn, padding: '10px 18px' }}>Close</button>
        </div>
      </div>
    </div>
  )
}

// Bottom-anchored, dismissable error banner for the full-screen wizard.
export function ErrorBanner({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <div
      role="alert"
      style={{
        position: 'absolute', left: '50%', bottom: 24, transform: 'translateX(-50%)',
        maxWidth: 'min(560px, calc(100% - 40px))',
        display: 'flex', alignItems: 'flex-start', gap: 10,
        padding: '11px 12px 11px 14px', borderRadius: 'var(--radius-md)',
        background: 'var(--bg-surface)', border: '1px solid color-mix(in srgb, var(--danger) 45%, transparent)',
        color: 'var(--danger)', fontSize: 12.5, lineHeight: 1.5,
        boxShadow: 'var(--shadow-popover)', zIndex: 70,
      }}
    >
      <span aria-hidden="true" style={{ marginTop: 1 }}>⚠</span>
      <span style={{ flex: 1, minWidth: 0 }}>{message}</span>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss error"
        style={{ background: 'transparent', border: 'none', color: 'var(--danger)', cursor: 'pointer', fontSize: 13, lineHeight: 1, padding: '0 2px', flexShrink: 0 }}
      >
        ✕
      </button>
    </div>
  )
}

export function PlanScreen({ feature, agent, busy, onStart }: { feature: string; agent: string; busy: boolean; onStart: () => void }) {
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
        <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontWeight: 500, marginBottom: 12 }}>
          Guided port-ification
        </div>
        <h2 style={{ fontSize: 16, fontWeight: 600, letterSpacing: '-0.01em', margin: '0 0 14px' }}>What will happen</h2>
        <p style={{ fontSize: 14, color: 'var(--text-secondary)', lineHeight: 1.65, margin: '0 0 10px' }}>
          The <b style={{ color: 'var(--text-primary)' }}>{agent}</b> agent edits <b style={{ color: 'var(--text-primary)' }}>{feature}</b> in an isolated scratch worktree so each app reads its listen port from an injected env var, and declares matching <code style={mono}>ports</code> slots in the feature config.
        </p>
        <p style={{ fontSize: 14, color: 'var(--text-secondary)', lineHeight: 1.65, margin: '0 0 24px' }}>
          The harness then boots the stack <b style={{ color: 'var(--text-primary)' }}>twice at once on different ports</b> and requires both to pass health checks — proof the rewrite works. You review the diff and save it.
        </p>

        <div style={{ border: '1px solid var(--border-default)', borderRadius: 'var(--radius-lg)', background: 'var(--bg-surface)', overflow: 'hidden', marginBottom: 26 }}>
          <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontWeight: 500, padding: '11px 16px', borderBottom: '1px solid var(--border-subtle)' }}>
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

export function ExerciseScreen({ m, live }: { m: PortifyManifest; live: boolean }) {
  // When viewed after the fact (live=false), every phase reads as done.
  const settled = !live || isNavigable(m.status)
  // External producer: the agent runs in the user's own client and edits the
  // worktree in place — there's no local agent session, no auto-retry loop.
  const external = m.producer === 'external'
  return (
    <div>
      <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>
        {external ? 'External port-ification' : live ? 'Running the exercise' : 'The exercise'}
      </div>
      <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginBottom: 18 }}>
        {external ? 'The agent runs in your own client and edits the scratch worktree in place.' : `Attempt ${Math.max(1, m.attempt)} of ${m.maxAttempts}`}
      </div>
      <div style={{ border: '1px solid var(--border-default)', borderRadius: 'var(--radius-lg)', overflow: 'hidden' }}>
        <Phase done label="Scratch worktree created" active={live && m.status === 'planning'} />
        <Phase done={settled || m.status === 'verifying'} active={live && m.status === 'editing'} label={external ? 'You rewrite ports in your client (source + config)' : 'Agent rewriting ports (source + config)'} />
        <Phase done={settled} active={live && m.status === 'verifying'} label="Booting twice on different ports + health checks" />
      </div>
      <div style={{ fontSize: 12.5, color: 'var(--accent)', marginTop: 14 }}>{STATUS_LABEL[m.status]}</div>
      {!external && live && m.verification && !m.verification.ok && m.verification.failureDetail && (
        <div style={{ marginTop: 12, fontSize: 11.5, fontFamily: 'var(--font-mono)', color: 'var(--warning)', background: 'var(--bg-base)', border: '1px solid var(--border-default)', borderRadius: 'var(--radius-md)', padding: '10px 12px', whiteSpace: 'pre-wrap' }}>
          Last attempt failed — retrying:{'\n'}{m.verification.failureDetail}
        </div>
      )}
      <div style={{ marginTop: 18 }}>
        <div style={{ fontSize: 10, fontFamily: 'var(--font-mono)', textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-muted)', fontWeight: 500, marginBottom: 8 }}>
          {external ? 'Session' : 'Agent'}
        </div>
        <div style={{ height: 360, border: '1px solid var(--border-default)', borderRadius: 'var(--radius-lg)', overflow: 'hidden' }}>
          {external
            ? <ExternalPortifyPanel m={m} />
            : <AgentSessionView source={{ kind: 'portify', workflowId: m.workflowId, live }} />}
        </div>
      </div>
    </div>
  )
}

export function Phase({ label, active, done }: { label: string; active?: boolean; done?: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '11px 14px', borderTop: '1px solid var(--border-default)' }}>
      <span style={{ fontSize: 13, color: done ? 'var(--success)' : active ? 'var(--accent)' : 'var(--text-muted)' }}>
        {done ? '✓' : active ? '●' : '○'}
      </span>
      <span style={{ fontSize: 13, color: done || active ? 'var(--text-primary)' : 'var(--text-muted)' }}>{label}</span>
    </div>
  )
}

export function ReviewScreen({ m, busy, saved, onSave, onRequestChanges, onDone }: { m: PortifyManifest; busy: boolean; saved: boolean; onSave: () => void; onRequestChanges: () => void; onDone: () => void }) {
  const rounds = m.feedbackRounds ?? 0
  // At ready-to-save verification is always set; a prior revise round may have
  // left it failed — in that case the diff isn't proven and can't be saved.
  const proven = m.verification?.ok === true
  const [openError, setOpenError] = useState<string | null>(null)
  // Open the scratch worktree in the user's editor while live. Best-effort:
  // surface a launch failure. (The saved view's open control lives inside
  // SavedOverlayPanel — it opens the overlay folder, not a worktree.)
  const openProject = async () => {
    setOpenError(null)
    try {
      const res = await api.openPortifyProject(m.workflowId)
      if (!res.opened) setOpenError(res.error ?? 'Failed to open editor')
    } catch (e) {
      setOpenError(e instanceof Error ? e.message : 'Failed to open editor')
    }
  }
  if (saved) {
    // The saved overlay rendering (diff + open-in-editor + proof + per-service
    // stored-in/apply rows) is the shared SavedOverlayPanel — the exact same
    // panel the Ports tab shows inline, so the two can never drift.
    return (
      <div>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6, color: 'var(--success)' }}>
          ✓ Saved — {m.feature} can now run in parallel
        </div>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.6, marginBottom: 14 }}>
          Parallel runs and benchmark arms each get their own ports. Your repo is never modified.
        </p>
        <SavedOverlayPanel manifest={m} />
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
          <button type="button" className="cl-button-primary" onClick={onDone} style={{ padding: '9px 16px' }}>Done</button>
        </div>
      </div>
    )
  }
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 12 }}>
        <div style={{ fontSize: 14, fontWeight: 600 }}>Review &amp; save</div>
        {rounds > 0 && (
          <span style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>
            revision {rounds}
          </span>
        )}
      </div>
      {proven ? <VerificationBadge m={m} /> : <RevisionFailedBanner m={m} />}
      <ReviewLocally m={m} openError={openError} />
      {/* A proven-but-empty diff isn't a missing capture — the apps already read
          injected ports, so the rewrite was a no-op (see orchestrator). Say so
          plainly instead of the bare "(no diff captured)". */}
      {(m.diff ?? '').trim()
        ? <DiffView diff={m.diff!} onOpenInEditor={openProject} />
        : proven
          ? <NoChangesNeeded feature={m.feature} />
          : <DiffView diff="" onOpenInEditor={openProject} />}
      {(
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
export function ReviewLocally({ m, openError }: { m: PortifyManifest; openError: string | null }) {
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
        {trees.map((r, i) => (
          <div key={r.name} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 11.5, color: 'var(--text-secondary)', flexShrink: 0 }}>{r.name}</span>
            <code style={{ ...mono, flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.worktreePath}</code>
            {/* The open is project-wide; surface its launch failure once, where the
                Copy-path button used to sit. */}
            {i === 0 && openError && (
              <span style={{ fontSize: 10.5, color: 'var(--danger)', flexShrink: 0 }}>{openError}</span>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

// Amber warning shown on the review screen when the most recent revise pass
// broke the double-boot (or touched tests) — mirrors the retry banner styling.
export function RevisionFailedBanner({ m }: { m: PortifyManifest }) {
  return (
    <div style={{ fontSize: 11.5, fontFamily: 'var(--font-mono)', color: 'var(--warning)', background: 'color-mix(in srgb, var(--warning) 8%, transparent)', border: '1px solid color-mix(in srgb, var(--warning) 30%, transparent)', borderRadius: 'var(--radius-md)', padding: '10px 12px', marginBottom: 14, whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>
      ⚠ Your last change didn't pass the double-boot — fix it with “Request changes” before saving.
      {m.verification?.failureDetail ? `\n\n${m.verification.failureDetail}` : ''}
      {m.error ? `\n\n${m.error}` : ''}
    </div>
  )
}

// Modal composer to send the agent review feedback. Autofocuses; Cmd/Ctrl+Enter
// submits; Escape / backdrop / Cancel closes (unless a send is in flight).
export function FeedbackModal({ busy, onSend, onClose }: { busy: boolean; onSend: (feedback: string) => void; onClose: () => void }) {
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
      style={{ position: 'absolute', inset: 0, background: 'var(--overlay-backdrop)', display: 'grid', placeItems: 'center', zIndex: 90 }}
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

export function FailedScreen({ m, onClose }: { m: PortifyManifest; onClose: () => void }) {
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
      <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8, color: 'var(--danger)' }}>
        {title}
      </div>
      {m.error && <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 12 }}>{m.error}</p>}
      {m.verification?.failureDetail && (
        <div style={{ fontSize: 11.5, fontFamily: 'var(--font-mono)', color: 'var(--warning)', background: 'var(--bg-base)', border: '1px solid var(--border-default)', borderRadius: 'var(--radius-md)', padding: '10px 12px', whiteSpace: 'pre-wrap', marginBottom: 14 }}>
          {m.verification.failureDetail}
        </div>
      )}
      {m.diff && <DiffView diff={m.diff} />}
      <button type="button" onClick={onClose} style={{ ...ghostBtn, marginTop: 16 }}>Close</button>
    </div>
  )
}

export const mono: React.CSSProperties = { fontFamily: 'var(--font-mono)', fontSize: 12, background: 'var(--bg-base)', border: '1px solid var(--border-default)', borderRadius: 'var(--radius-sm)', padding: '1px 5px' }
