import { useEffect, useRef, useState } from 'react'
import { useEscapeToClose } from '@/shared/ui/Overlays'
import { useOpenPortifyProject } from '../state/use-open-portify-project'
import type { PortifyManifest } from '@/shared/api/portify'
import { DiffView } from '@/shared/ui/DiffView'
import { NoChangesNeeded, VerificationBadge } from './SavedOverlayPanel'
const ghostBtn: React.CSSProperties = {
  padding: '8px 14px', background: 'var(--bg-surface)', border: '1px solid var(--border-default)',
  borderRadius: 'var(--radius-md)', color: 'var(--text-secondary)', fontSize: 12, fontWeight: 500, cursor: 'pointer',
}

export function ReviewScreen({ m, busy, canRequestChanges = true, onSave, onRequestChanges }: { m: PortifyManifest; busy: boolean; canRequestChanges?: boolean; onSave: () => void; onRequestChanges: () => void }) {
  const rounds = m.feedbackRounds ?? 0
  // At ready-to-save verification is always set; a prior revise round may have
  // left it failed — in that case the diff isn't proven and can't be saved.
  const proven = m.verification?.ok === true
  const { openError, openProject } = useOpenPortifyProject(m.workflowId)
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
          {canRequestChanges && <button
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
          </button>}
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
function ReviewLocally({ m, openError }: { m: PortifyManifest; openError: string | null }) {
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
function RevisionFailedBanner({ m }: { m: PortifyManifest }) {
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
  // The layer stays registered while a send is in flight, so Escape is still
  // swallowed here rather than falling through to the screen beneath.
  useEscapeToClose(() => { if (!busy) onClose() })
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
        className="cl-modal"
        style={{ width: 'min(560px, 92%)', background: 'var(--bg-surface)', border: '1px solid var(--border-default)', borderRadius: 'var(--radius-lg)', padding: 20, overflowY: 'auto' }}
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

const mono: React.CSSProperties = { fontFamily: 'var(--font-mono)', fontSize: 12, background: 'var(--bg-base)', border: '1px solid var(--border-default)', borderRadius: 'var(--radius-sm)', padding: '1px 5px' }
