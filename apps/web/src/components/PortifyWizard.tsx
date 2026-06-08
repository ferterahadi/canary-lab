import { useCallback, useEffect, useRef, useState } from 'react'
import * as api from '../api/client'
import type { PortifyManifest, PortifyStatus } from '../api/client'
import { AgentSessionView } from './AgentSessionView'

// Guided port-ification: an agent rewrites the feature's apps to use injectable
// ports, proven by a concurrent double-boot, ending at a user commit. Full-
// screen overlay mirroring the benchmark window. Auto-polls the manifest.

const STEPS: { key: string; label: string; sub: string }[] = [
  { key: 'plan', label: 'Plan', sub: 'what changes' },
  { key: 'exercise', label: 'Exercise', sub: 'agent + verify' },
  { key: 'review', label: 'Review', sub: 'diff + proof' },
  { key: 'commit', label: 'Commit', sub: 'to branch' },
]

function stepIndexFor(phase: 'plan' | PortifyStatus): number {
  switch (phase) {
    case 'plan': return 0
    case 'planning':
    case 'editing':
    case 'verifying': return 1
    case 'ready-to-commit':
    case 'failed': return 2
    case 'committed': return 3
    default: return 1
  }
}

const STATUS_LABEL: Record<PortifyStatus, string> = {
  planning: 'Setting up branch + worktree…',
  editing: 'Agent is rewriting ports…',
  verifying: 'Booting twice on different ports…',
  'ready-to-commit': 'Verified — ready to commit',
  committed: 'Committed',
  failed: 'Could not make it work',
  aborted: 'Cancelled',
}

export function PortifyWizard({
  feature,
  agent = 'claude',
  workflowId: initialWorkflowId,
  onClose,
  onCommitted,
}: {
  /** New mode: the feature to port-ify (Plan screen → Start). */
  feature?: string
  agent?: 'claude' | 'codex'
  /** Revisit mode: reopen an in-flight workflow by id (skip the Plan screen). */
  workflowId?: string
  onClose: () => void
  onCommitted: () => void
}) {
  const [workflowId, setWorkflowId] = useState<string | null>(initialWorkflowId ?? null)
  const [m, setM] = useState<PortifyManifest | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmLeave, setConfirmLeave] = useState(false)
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
        if (['ready-to-commit', 'committed', 'failed', 'aborted'].includes(next.status)) stopPolling()
      } catch { /* transient */ }
    }
    void tick()
    pollRef.current = window.setInterval(tick, 1500)
    return stopPolling
  }, [workflowId, stopPolling])

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

  const commit = async () => {
    if (!workflowId) return
    setBusy(true); setError(null)
    try {
      await api.commitPortify(workflowId)
      onCommitted()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  // Leave: discard the workflow (worktree + branch) if one is in flight.
  const leave = async () => {
    stopPolling()
    if (workflowId && m && m.status !== 'committed') {
      try { await api.cancelPortify(workflowId) } catch { /* best-effort */ }
    }
    onClose()
  }

  const status = m?.status
  const stepIdx = stepIndexFor(workflowId ? (status ?? 'planning') : 'plan')

  return (
    <div className="fixed inset-0 z-[80] flex flex-col" style={{ background: 'var(--bg-base)' }}>
      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 20px', borderBottom: '1px solid var(--border-default)' }}>
        <div style={{ fontWeight: 600, fontSize: 15 }}>
          Make ports injectable <span style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontSize: 13, marginLeft: 8 }}>{m?.feature ?? feature ?? ''}</span>
        </div>
        <button type="button" onClick={() => setConfirmLeave(true)} style={{ background: 'transparent', border: '1px solid var(--border-default)', borderRadius: 'var(--radius-md)', color: 'var(--text-secondary)', fontSize: 12, padding: '6px 12px', cursor: 'pointer' }}>
          Close ✕
        </button>
      </header>

      <Stepper current={stepIdx} />

      <div style={{ flex: 1, overflow: 'auto', padding: '20px 22px 60px', display: 'flex', justifyContent: 'center', alignItems: 'flex-start' }}>
        <div style={{ width: 'min(820px, 100%)' }}>
          {!workflowId && feature && <PlanScreen feature={feature} agent={agent} busy={busy} onStart={start} />}
          {workflowId && !m && (
            <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>Loading…</div>
          )}
          {workflowId && m && (status === 'planning' || status === 'editing' || status === 'verifying') && (
            <ExerciseScreen m={m} />
          )}
          {workflowId && m && status === 'ready-to-commit' && (
            <ReviewScreen m={m} busy={busy} onCommit={commit} onCancel={() => setConfirmLeave(true)} />
          )}
          {workflowId && m && status === 'committed' && <CommittedScreen m={m} onDone={onCommitted} />}
          {workflowId && m && (status === 'failed' || status === 'aborted') && (
            <FailedScreen m={m} onClose={leave} />
          )}
          {error && <div style={{ color: 'rgb(251,113,133)', fontSize: 12, marginTop: 14 }}>{error}</div>}
        </div>
      </div>

      {confirmLeave && (
        <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'grid', placeItems: 'center', zIndex: 90 }}>
          <div style={{ width: 'min(420px, 92%)', background: 'var(--bg-surface)', border: '1px solid var(--border-default)', borderRadius: 'var(--radius-lg)', padding: 20 }}>
            <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 8 }}>Leave this workflow?</div>
            <div style={{ fontSize: 12.5, color: 'var(--text-muted)', lineHeight: 1.6, marginBottom: 16 }}>
              {m && m.status === 'committed'
                ? 'The change is committed. You can close safely.'
                : 'The branch and worktree will be discarded and the feature config restored. Nothing is committed.'}
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button type="button" onClick={() => setConfirmLeave(false)} style={ghostBtn}>Stay</button>
              <button type="button" onClick={leave} style={{ ...ghostBtn, color: 'rgb(251,113,133)', borderColor: 'rgba(251,113,133,0.4)' }}>Leave</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

const ghostBtn: React.CSSProperties = {
  padding: '8px 14px', background: 'transparent', border: '1px solid var(--border-default)',
  borderRadius: 'var(--radius-md)', color: 'var(--text-secondary)', fontSize: 12, cursor: 'pointer',
}

function Stepper({ current }: { current: number }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 0, padding: '14px 20px', borderBottom: '1px solid var(--border-default)' }}>
      {STEPS.map((s, i) => (
        <div key={s.key} style={{ display: 'flex', alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, opacity: i <= current ? 1 : 0.45 }}>
            <span style={{
              width: 20, height: 20, borderRadius: 9999, display: 'grid', placeItems: 'center', fontSize: 11, fontWeight: 700,
              border: `2px solid ${i <= current ? 'var(--accent)' : 'var(--border-default)'}`,
              color: i <= current ? 'var(--accent)' : 'var(--text-muted)',
            }}>{i + 1}</span>
            <span style={{ fontSize: 12 }}>
              <b style={{ color: 'var(--text-primary)' }}>{s.label}</b>
              <span style={{ color: 'var(--text-muted)', marginLeft: 6 }}>{s.sub}</span>
            </span>
          </div>
          {i < STEPS.length - 1 && <span style={{ width: 40, height: 2, background: 'var(--border-default)', margin: '0 12px' }} />}
        </div>
      ))}
    </div>
  )
}

function PlanScreen({ feature, agent, busy, onStart }: { feature: string; agent: string; busy: boolean; onStart: () => void }) {
  return (
    <div>
      <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 8 }}>What will happen</div>
      <p style={{ fontSize: 13.5, color: 'var(--text-muted)', lineHeight: 1.6, marginBottom: 16, maxWidth: 640 }}>
        The <b style={{ color: 'var(--text-secondary)' }}>{agent}</b> agent will edit <b style={{ color: 'var(--text-secondary)' }}>{feature}</b> on a dedicated branch in an isolated worktree so each app reads its listen port from an injected env var, and declares matching <code style={mono}>ports</code> slots in the feature config. Then the harness boots the stack <b style={{ color: 'var(--text-secondary)' }}>twice at once on different ports</b> and requires both to pass health checks — proof the rewrite works. You review the diff and commit.
      </p>
      <ul style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.8, marginBottom: 22 }}>
        <li>Source edits land on branch <code style={mono}>canary/dynamic-ports-…</code> (your main tree is untouched).</li>
        <li>Test files are never modified.</li>
        <li>Nothing is committed until you approve the verified diff.</li>
      </ul>
      <button type="button" className="cl-button-primary" disabled={busy} onClick={onStart} style={{ padding: '9px 18px' }}>
        {busy ? 'Starting…' : 'Start ▶'}
      </button>
    </div>
  )
}

function ExerciseScreen({ m }: { m: PortifyManifest }) {
  return (
    <div>
      <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 4 }}>Running the exercise</div>
      <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginBottom: 18 }}>
        Attempt {Math.max(1, m.attempt)} of {m.maxAttempts}
      </div>
      <div style={{ border: '1px solid var(--border-default)', borderRadius: 'var(--radius-lg)', overflow: 'hidden' }}>
        <Phase done label="Branch + worktree created" active={m.status === 'planning'} />
        <Phase done={m.status === 'verifying' || m.status === 'ready-to-commit'} active={m.status === 'editing'} label="Agent rewriting ports (source + config)" />
        <Phase active={m.status === 'verifying'} label="Booting twice on different ports + health checks" />
      </div>
      <div style={{ fontSize: 12.5, color: 'var(--accent)', marginTop: 14 }}>{STATUS_LABEL[m.status]}</div>
      {m.verification && !m.verification.ok && m.verification.failureDetail && (
        <div style={{ marginTop: 12, fontSize: 11.5, fontFamily: 'var(--font-mono)', color: 'rgb(251,191,36)', background: 'var(--bg-base)', border: '1px solid var(--border-default)', borderRadius: 'var(--radius-md)', padding: '10px 12px', whiteSpace: 'pre-wrap' }}>
          Last attempt failed — retrying:{'\n'}{m.verification.failureDetail}
        </div>
      )}
      <div style={{ marginTop: 18 }}>
        <div style={{ fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '.4px', color: 'var(--text-muted)', fontWeight: 600, marginBottom: 8 }}>
          Agent
        </div>
        <div style={{ height: 360, border: '1px solid var(--border-default)', borderRadius: 'var(--radius-lg)', overflow: 'hidden' }}>
          <AgentSessionView source={{ kind: 'portify', workflowId: m.workflowId, live: true }} />
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

function ReviewScreen({ m, busy, onCommit, onCancel }: { m: PortifyManifest; busy: boolean; onCommit: () => void; onCancel: () => void }) {
  return (
    <div>
      <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 12 }}>Review &amp; commit</div>
      <VerificationBadge m={m} />
      <DiffView diff={m.diff ?? ''} />
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 16 }}>
        <button type="button" className="cl-button-primary" disabled={busy} onClick={onCommit} style={{ padding: '9px 16px' }}>
          {busy ? 'Committing…' : 'Commit'}
        </button>
        <button type="button" onClick={onCancel} style={ghostBtn}>Cancel</button>
        <span style={{ fontSize: 11.5, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
          feat: make {m.feature} ports injectable · branch {m.branch}
        </span>
      </div>
    </div>
  )
}

function CommittedScreen({ m, onDone }: { m: PortifyManifest; onDone: () => void }) {
  const committed = m.repos.filter((r) => r.commitSha)
  return (
    <div>
      <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 8, color: 'rgb(52,211,153)' }}>✓ Committed</div>
      <p style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.6, marginBottom: 12 }}>
        The port rewrite is committed to <code style={mono}>{m.branch}</code>. Re-open the benchmark to run it now — both arms will boot on distinct ports.
      </p>
      <div style={{ marginBottom: 18 }}>
        {committed.length === 0 && (
          <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>No source changes were needed — the apps already honor injected ports; the config now declares the slots.</div>
        )}
        {committed.map((r) => (
          <div key={r.name} style={{ fontSize: 12, fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)' }}>
            {r.name} <code style={mono}>{r.commitSha!.slice(0, 10)}</code>
          </div>
        ))}
      </div>
      <button type="button" className="cl-button-primary" onClick={onDone} style={{ padding: '9px 16px' }}>Done</button>
    </div>
  )
}

function FailedScreen({ m, onClose }: { m: PortifyManifest; onClose: () => void }) {
  return (
    <div>
      <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 8, color: 'rgb(251,113,133)' }}>
        {m.status === 'aborted' ? 'Cancelled' : 'Could not make it work'}
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
