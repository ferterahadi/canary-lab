import { useEffect, useRef, useState } from 'react'
import type { CoverageJobManifest } from '../api/types'

// R13/R15: the dedicated Generating screen. While a coverage/summary job runs, the
// Coverage tab shows THIS and nothing else — never the ledger, never the empty
// state. Summary + Coverage are one exercise (R14), so the screen is phase-aware:
// it walks ① Summarizing docs → ② Mapping coverage as the chained job advances.
//
// The live agent output streams into a condensed tail; "View agent activity"
// expands the full log. (R17 mount point: when the job carries a structured
// agent session ref, swap the expanded log for <AgentSessionView source=coverage>.)

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
  const [expanded, setExpanded] = useState(false)
  const logRef = useRef<HTMLPreElement | null>(null)
  // The active phase is just the running job's kind. A standalone coverage job
  // (no summary phase) shows ① as already-done.
  const activeIndex = job.kind === 'summary' ? 0 : 1
  const standaloneCoverage = job.kind === 'coverage' && !job.chainedFromJobId

  // Keep the streaming tail pinned to the newest output.
  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [job.log, expanded])

  const tail = condenseTail(job.log, expanded ? 400 : 8)

  return (
    <div className="min-h-0 flex-1 overflow-auto" data-testid="coverage-generating">
      <div style={{ maxWidth: 640, margin: '44px auto 0', padding: '0 24px 40px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
          <span className="cl-pulse" aria-hidden="true" style={{ width: 9, height: 9, borderRadius: '50%', background: 'rgb(56, 189, 248)', boxShadow: '0 0 10px rgb(56,189,248)' }} />
          <span style={{ fontSize: 12, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'rgb(56, 189, 248)' }}>
            Generating
          </span>
        </div>
        <h2 style={{ fontSize: 20, fontWeight: 700, color: 'var(--text-primary)', margin: '6px 0 4px' }}>
          {job.kind === 'summary' ? 'Summarizing & mapping coverage' : 'Mapping coverage'}
        </h2>
        <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5, marginBottom: 24 }}>
          Summary and coverage run as one exercise for <strong style={{ color: 'var(--text-primary)' }}>{feature}</strong>. This can take a minute — it keeps running if you close this view.
        </p>

        {/* Phase stepper — current phase pulses, earlier phases are done. */}
        <div aria-live="polite" data-testid="generating-phases">
          {PHASES.map((p, i) => {
            const done = standaloneCoverage ? p.key === 'summary' : i < activeIndex
            const active = !done && i === (standaloneCoverage ? 1 : activeIndex)
            return <PhaseRow key={p.key} n={i + 1} title={p.title} body={p.body} done={done} active={active} />
          })}
        </div>

        <div style={{ marginTop: 22 }}>
          <button
            type="button"
            data-testid="toggle-agent-activity"
            onClick={() => setExpanded((v) => !v)}
            className="cl-button px-3 py-1.5"
            aria-expanded={expanded}
            style={{ fontSize: 12 }}
          >
            {expanded ? 'Hide agent activity' : 'View agent activity'}
          </button>
        </div>

        <pre
          ref={logRef}
          data-testid="generating-log"
          style={{
            marginTop: 12,
            maxHeight: expanded ? 420 : 132,
            overflow: 'auto',
            fontSize: 11,
            lineHeight: 1.5,
            fontFamily: 'var(--font-mono, monospace)',
            color: 'var(--text-secondary)',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            background: 'var(--bg-base)',
            border: '1px solid var(--border-default)',
            borderRadius: 'var(--radius-md)',
            padding: 12,
            transition: 'max-height 150ms',
          }}
        >
          {tail || 'Starting the agent…'}
        </pre>
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
