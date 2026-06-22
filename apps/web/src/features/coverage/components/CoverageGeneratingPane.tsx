import { useEffect, useState } from 'react'
import type { CoverageJobManifest } from '../../../shared/api/types'
import { AgentSessionView } from '../../agent-sessions/components/AgentSessionView'

// R13/R15: the dedicated Generating screen. While a coverage/summary job runs, the
// Coverage tab shows THIS and nothing else — never the ledger, never the empty
// state. Summary + Coverage are one exercise (R14), so the screen is phase-aware:
// it walks ① Summarizing docs → ② Mapping coverage as the chained job advances.
//
// The summary + mapping agents are AGENTIC — they read the source docs/specs with
// their tools — so the agent's real work (reads, reasoning, tool steps) streams
// through AgentSessionView. One agent timeline everywhere (cl_ui-design-philosophy),
// always visible: no Hide/Show button, no Live/Timeline toggle, no raw <pre> log.

interface Props {
  feature: string
  job: CoverageJobManifest
}

type Phase = 'summary' | 'coverage'

const PHASES: Array<{ key: Phase; title: string; body: string }> = [
  { key: 'summary', title: 'Summarizing docs', body: 'Reading the source docs and extracting testable requirements with stable ids.' },
  { key: 'coverage', title: 'Mapping coverage', body: 'Reading the test specs and inferring which test covers each requirement.' },
]

export function CoverageGeneratingPane({ feature, job }: Props) {
  // The active phase is just the running job's kind. A standalone coverage job
  // (no summary phase) shows ① as already-done.
  const activeIndex = job.kind === 'summary' ? 0 : 1
  const standaloneCoverage = job.kind === 'coverage' && !job.chainedFromJobId
  // External (offloaded) jobs: the mapping runs in the user's own client, so
  // there is NO Canary-spawned agent session to stream. Render the job
  // monitor-only (client metadata + tracked log) instead of AgentSessionView.
  const isExternal = job.producer === 'external'

  // Elapsed timer — a constant liveness signal even before the agent pins its
  // session and the timeline starts streaming, so the screen never reads frozen.
  const [elapsed, setElapsed] = useState(0)
  useEffect(() => {
    const started = Date.parse(job.startedAt)
    const tick = () => setElapsed(Number.isFinite(started) ? Math.max(0, Math.round((Date.now() - started) / 1000)) : 0)
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [job.startedAt])

  return (
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

        {/* Internal: the agent reads the docs/specs with its tools; its work
            streams here. External (offload): no Canary agent — show the tracked
            job log + the client driving it (monitor-only). */}
        <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: '18px 2px 8px', lineHeight: 1.5 }}>
          {isExternal
            ? 'Mapping runs in your connected client — Canary tracks it here and recomputes the ledger when the client submits.'
            : `${job.kind === 'summary' ? 'Reading the source docs' : 'Reading the test specs'} and reasoning — the agent’s steps stream below.`}
        </p>
        {isExternal ? (
          <ExternalMonitorPanel job={job} />
        ) : (
          <div
            data-testid="coverage-agent-session"
            style={{
              position: 'relative', height: 360, overflow: 'hidden',
              background: 'var(--bg-base)', border: '1px solid var(--border-default)', borderRadius: 'var(--radius-md)',
            }}
          >
            <AgentSessionView source={{ kind: 'coverage', jobId: job.jobId, live: true }} />
          </div>
        )}
      </div>
    </div>
  )
}

// Monitor-only view for an offloaded (external-producer) coverage job: the
// mapping happens in the user's own client, so we show who is driving it +
// Canary's tracked log instead of a (non-existent) agent session stream.
function ExternalMonitorPanel({ job }: { job: CoverageJobManifest }) {
  const rows: Array<[string, string | undefined]> = [
    ['Client', job.externalClientKind],
    ['Session', job.externalSessionId],
    ['Conversation', job.externalConversationName],
  ]
  const visible = rows.filter(([, v]) => v)
  return (
    <div
      data-testid="coverage-external-monitor"
      style={{ background: 'var(--bg-base)', border: '1px solid var(--border-default)', borderRadius: 'var(--radius-md)', padding: 16 }}
    >
      {visible.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 20px', marginBottom: 12 }}>
          {visible.map(([k, v]) => (
            <div key={k} style={{ fontSize: 12, minWidth: 0 }}>
              <span style={{ color: 'var(--text-muted)' }}>{k}: </span>
              <span style={{ color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums', wordBreak: 'break-word' }}>{v}</span>
            </div>
          ))}
        </div>
      )}
      <pre
        data-testid="coverage-external-log"
        style={{
          margin: 0, maxHeight: 300, overflow: 'auto', fontSize: 12, lineHeight: 1.5,
          color: 'var(--text-secondary)', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        }}
      >
        {job.log || 'Waiting for the client to submit mappings…'}
      </pre>
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
