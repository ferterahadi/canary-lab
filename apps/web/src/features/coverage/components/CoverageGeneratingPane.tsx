import { useEffect, useRef, useState } from 'react'
import type { CoverageJobManifest } from '../../../api/types'
import { AgentSessionView } from '../../agent-sessions/components/AgentSessionView'

// R13/R15: the dedicated Generating screen. While a coverage/summary job runs, the
// Coverage tab shows THIS and nothing else — never the ledger, never the empty
// state. Summary + Coverage are one exercise (R14), so the screen is phase-aware:
// it walks ① Summarizing docs → ② Mapping coverage as the chained job advances.
//
// Collapsed (default) the screen stays clean: just the phase stepper + a hint.
// "View agent activity" expands the real agent timeline (R17) — when the job
// carries a structured session ref we mount <AgentSessionView source=coverage>;
// a deterministic / no-agent run has no session, so we fall back to the
// condensed raw log so the panel is never empty.

interface Props {
  feature: string
  job: CoverageJobManifest
}

type Phase = 'summary' | 'coverage'

const PHASES: Array<{ key: Phase; title: string; body: string }> = [
  { key: 'summary', title: 'Summarizing docs', body: 'Extracting testable requirements with stable ids.' },
  { key: 'coverage', title: 'Mapping coverage', body: 'Inferring which test covers each requirement and writing covers tags.' },
]

export function CoverageGeneratingPane({ feature, job }: Props) {
  // Agent activity is shown by DEFAULT — seeing the model work is the point.
  const [expanded, setExpanded] = useState(true)
  // 'live' = the stream-json token stream (watch the answer being written);
  // 'timeline' = the structured session (prompt + final). Live is the default
  // because for a single-completion agent it's the only thing that streams.
  const [actView, setActView] = useState<'live' | 'timeline'>('live')
  const logRef = useRef<HTMLPreElement | null>(null)
  // The active phase is just the running job's kind. A standalone coverage job
  // (no summary phase) shows ① as already-done.
  const activeIndex = job.kind === 'summary' ? 0 : 1
  const standaloneCoverage = job.kind === 'coverage' && !job.chainedFromJobId

  const hasSession = Boolean(job.sessionRef)

  // Elapsed timer — a single inference has no intermediate steps to stream, so a
  // ticking "working… Ns" is what tells the user it's alive, not frozen.
  const [elapsed, setElapsed] = useState(0)
  useEffect(() => {
    const started = Date.parse(job.startedAt)
    const tick = () => setElapsed(Number.isFinite(started) ? Math.max(0, Math.round((Date.now() - started) / 1000)) : 0)
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [job.startedAt])

  // Keep the live log pinned to the newest streamed output.
  const showingLog = expanded && (actView === 'live' || !hasSession)
  useEffect(() => {
    if (!showingLog) return
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [job.log, showingLog])

  const tail = condenseTail(job.log, 400)

  return (
    // scrollbarGutter:stable reserves the scrollbar track so toggling the agent
    // activity (which grows past the column) doesn't shift the layout.
    <div className="min-h-0 h-full overflow-auto" data-testid="coverage-generating" style={{ scrollbarGutter: 'stable' }}>
      <div style={{ maxWidth: 720, margin: '0 auto', padding: '26px 24px 40px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
          <span className="cl-pulse" aria-hidden="true" style={{ width: 9, height: 9, borderRadius: '50%', background: 'rgb(56, 189, 248)', boxShadow: '0 0 10px rgb(56,189,248)' }} />
          <span style={{ fontSize: 12, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'rgb(56, 189, 248)' }}>
            Generating
          </span>
          <span data-testid="generating-elapsed" style={{ fontSize: 11, color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' }}>· {elapsed}s</span>
        </div>
        <h2 style={{ fontSize: 19, fontWeight: 700, color: 'var(--text-primary)', margin: '6px 0 4px' }}>
          {job.kind === 'summary' ? 'Summarizing & mapping coverage' : 'Mapping coverage'}
        </h2>
        <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5, marginBottom: 22 }}>
          Summary and coverage run as one exercise for <strong style={{ color: 'var(--text-primary)' }}>{feature}</strong>. Keeps running if you close this view.
        </p>

        {/* Phase stepper — current phase pulses, earlier phases are done. */}
        <div aria-live="polite" data-testid="generating-phases">
          {PHASES.map((p, i) => {
            const done = standaloneCoverage ? p.key === 'summary' : i < activeIndex
            const active = !done && i === (standaloneCoverage ? 1 : activeIndex)
            return <PhaseRow key={p.key} n={i + 1} title={p.title} body={p.body} done={done} active={active} />
          })}
        </div>

        <div style={{ marginTop: 18, display: 'flex', alignItems: 'center', gap: 12 }}>
          <button
            type="button"
            data-testid="toggle-agent-activity"
            onClick={() => setExpanded((v) => !v)}
            className="cl-button px-3 py-1.5"
            aria-expanded={expanded}
            style={{ fontSize: 12 }}
          >
            {expanded ? 'Hide agent activity' : 'Show agent activity'}
          </button>
        </div>

        {expanded && (
          <>
            {/* Two ways to watch: the LIVE token stream (default — the model's
                answer as it writes) or the structured session timeline. */}
            {hasSession && (
              <div role="tablist" style={{ display: 'inline-flex', gap: 2, marginTop: 12, padding: 3, borderRadius: 'var(--radius-md)', background: 'var(--bg-base)', border: '1px solid var(--border-default)' }}>
                {(['live', 'timeline'] as const).map((v) => (
                  <button
                    key={v}
                    type="button"
                    data-testid={`activity-${v}`}
                    data-on={actView === v ? 'true' : 'false'}
                    onClick={() => setActView(v)}
                    style={{
                      appearance: 'none', border: 'none', cursor: 'pointer',
                      padding: '4px 12px', fontSize: 11.5, fontWeight: 600, borderRadius: 'calc(var(--radius-md) - 3px)',
                      background: actView === v ? 'var(--bg-selected)' : 'transparent',
                      color: actView === v ? 'var(--text-primary)' : 'var(--text-secondary)',
                    }}
                  >
                    {v === 'live' ? 'Live output' : 'Timeline'}
                  </button>
                ))}
              </div>
            )}

            {hasSession && actView === 'timeline' ? (
              <div
                data-testid="coverage-agent-session"
                style={{
                  marginTop: 12, position: 'relative', height: 360, overflow: 'hidden',
                  background: 'var(--bg-base)', border: '1px solid var(--border-default)', borderRadius: 'var(--radius-md)',
                }}
              >
                <AgentSessionView source={{ kind: 'coverage', jobId: job.jobId, live: true }} />
              </div>
            ) : (
              <pre
                ref={logRef}
                data-testid="generating-log"
                style={{
                  marginTop: 12, marginBottom: 0,
                  maxHeight: 360, overflow: 'auto',
                  fontSize: 11, lineHeight: 1.5,
                  fontFamily: 'var(--font-mono, monospace)', color: 'var(--text-secondary)',
                  whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                  background: 'var(--bg-base)', border: '1px solid var(--border-default)',
                  borderRadius: 'var(--radius-md)', padding: 12, scrollbarGutter: 'stable',
                }}
              >
                {tail || 'Starting the agent…'}
              </pre>
            )}
            {/* Honest framing — these agents are single completions (no tool/read
                steps); Live output is the model's answer streaming in. */}
            <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: '8px 2px 0', lineHeight: 1.5 }}>
              {job.kind === 'summary' ? 'Summarizing' : 'Mapping'} is a single model inference — Live output is its response streaming in (no intermediate tool steps).
            </p>
          </>
        )}
      </div>
    </div>
  )
}

function PhaseRow({ n, title, body, done, active }: { n: number; title: string; body: string; done: boolean; active: boolean }) {
  const accent = done ? 'rgb(52, 211, 153)' : active ? 'rgb(56, 189, 248)' : 'var(--text-muted)'
  return (
    <div
      data-testid={`phase-${n}`}
      data-state={done ? 'done' : active ? 'active' : 'pending'}
      style={{
        display: 'flex', gap: 14, padding: '14px 16px', marginBottom: 10,
        borderRadius: 'var(--radius-md)',
        border: `1px solid ${active ? 'color-mix(in srgb, rgb(56,189,248) 45%, var(--border-default))' : 'var(--border-default)'}`,
        background: active ? 'color-mix(in srgb, rgb(56,189,248) 8%, var(--bg-surface))' : 'var(--bg-surface)',
        opacity: !active && !done ? 0.6 : 1,
        transition: 'opacity 150ms, border-color 150ms, background 150ms',
      }}
    >
      <div
        aria-hidden="true"
        className={active ? 'cl-pulse' : undefined}
        style={{
          flexShrink: 0, width: 26, height: 26, borderRadius: '50%',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 13, fontWeight: 700,
          background: done || active ? accent : 'var(--bg-base)',
          color: done || active ? '#0b0f17' : 'var(--text-muted)',
          border: done || active ? 'none' : '1px solid var(--border-default)',
        }}
      >
        {done ? '✓' : n}
      </div>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: 8 }}>
          {title}
          {active && <span style={{ fontSize: 10, color: accent }}>in progress…</span>}
          {done && <span style={{ fontSize: 10, color: accent }}>done</span>}
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.45, marginTop: 3 }}>{body}</div>
      </div>
    </div>
  )
}

// Keep the last `n` non-empty lines so the tail reads as live activity, not a
// wall of replayed boot output.
function condenseTail(log: string, n: number): string {
  const lines = log.split('\n').filter((l) => l.trim().length > 0)
  return lines.slice(-n).join('\n')
}
