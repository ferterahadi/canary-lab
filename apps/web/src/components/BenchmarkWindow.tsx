import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import * as api from '../api/client'
import type { Feature } from '../api/types'
import type { BenchmarkArm, BenchmarkManifest, SabotageLevel, SabotageSkillSummary } from '../api/benchmark-types'
import { useBenchmark, useBenchmarks } from '../state/BenchmarkContext'
import { RunDetailColumn } from './RunDetailColumn'
import { AgentSessionView } from './AgentSessionView'

// The benchmark workspace window: a large portal-style overlay (config → setup →
// race → report). Per-arm monitoring reuses the real RunDetailColumn.

const LEVEL_BADGE: Record<SabotageLevel, { bg: string; fg: string }> = {
  min: { bg: 'rgba(16,185,129,0.15)', fg: 'rgb(52,211,153)' },
  med: { bg: 'rgba(245,158,11,0.15)', fg: 'rgb(251,191,36)' },
  max: { bg: 'rgba(244,63,94,0.15)', fg: 'rgb(251,113,133)' },
}

// One matrix that captures BOTH what the two benchmark arms share and where they
// diverge — so a single table tells the whole story. Mirrors the arm wiring in
// lib/runtime/benchmark/arm-config.ts + the CANARY_LAB_BENCHMARK_MODE enrichment
// gate in summary-reporter.ts. `harness`/`baseline` = whether that arm gets it.
type ArmRow = { label: string; detail: string; harness: boolean; baseline: boolean }
const ARM_MATRIX: { section: string; note: string; rows: ArmRow[] }[] = [
  {
    section: 'Shared — both arms start here',
    note: 'identical, so the race never measures these',
    rows: [
      { label: 'claude agent + model', detail: 'same CLI, same model', harness: true, baseline: true },
      { label: 'Frozen bug', detail: 'the same sabotage commit', harness: true, baseline: true },
      { label: 'Booted services', detail: 'the orchestrator brings the app up', harness: true, baseline: true },
      { label: 'npx playwright test', detail: 'the arm reruns the suite itself', harness: true, baseline: true },
      { label: 'Playwright MCP', detail: 'drive browser, snapshot, network', harness: true, baseline: true },
      { label: 'Own browser trace', detail: 'Playwright trace.zip in its worktree', harness: true, baseline: true },
      { label: 'Completion signal', detail: 'the .restart / .rerun protocol', harness: true, baseline: true },
    ],
  },
  {
    section: 'canary-lab failure context — harness only',
    note: 'curated & captured by the harness — the one variable under test',
    rows: [
      { label: 'heal-index', detail: 'failed tests, assertions, editable repos, exact slice paths', harness: true, baseline: false },
      { label: 'Sliced failure logs', detail: 'per-failure service-log excerpts, not the raw log', harness: true, baseline: false },
      { label: 'Trace-extract', detail: 'failing action + selector, a11y snapshot, failed network, console', harness: true, baseline: false },
      { label: 'Diagnosis journal', detail: 'what prior heal cycles already tried', harness: true, baseline: false },
      { label: 'Captured service logs', detail: 'canary-lab’s svc-*.log capture', harness: true, baseline: false },
      { label: 'Playwright summary', detail: 'the e2e-summary.json reporter output', harness: true, baseline: false },
      { label: 'Feature docs / wiki', detail: 'product context + preserved prior work', harness: true, baseline: false },
    ],
  },
]

function Cell({ on }: { on: boolean }) {
  return (
    <span style={{ textAlign: 'center', fontWeight: 700, color: on ? 'rgb(52,211,153)' : 'var(--text-muted)', opacity: on ? 1 : 0.5 }}>
      {on ? '✓' : '✗'}
    </span>
  )
}

// The unified comparison table — similarities AND differences in one grid.
function ArmMatrixTable() {
  const COLS = '1fr 84px 84px'
  return (
    <div style={{ border: '1px solid var(--border-default)', borderRadius: 'var(--radius-lg)', overflow: 'hidden', background: 'var(--bg-surface)' }}>
      <div style={{ display: 'grid', gridTemplateColumns: COLS, alignItems: 'center', padding: '9px 15px', borderBottom: '1px solid var(--border-default)', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.4px', color: 'var(--text-muted)', position: 'sticky', top: 0, background: 'var(--bg-surface)' }}>
        <span>Capability</span>
        <span style={{ textAlign: 'center', color: 'var(--boot)' }}>🐤 Harness</span>
        <span style={{ textAlign: 'center', color: 'var(--accent)' }}>⚙ Baseline</span>
      </div>
      {ARM_MATRIX.map((group) => (
        <Fragment key={group.section}>
          <div style={{ padding: '9px 15px 7px', background: 'var(--bg-base)', borderBottom: '1px solid var(--border-default)' }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)' }}>{group.section}</span>
            <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 8 }}>{group.note}</span>
          </div>
          {group.rows.map((row) => (
            <div key={row.label} style={{ display: 'grid', gridTemplateColumns: COLS, alignItems: 'center', padding: '9px 15px', borderTop: '1px solid var(--border-default)' }}>
              <span style={{ fontSize: 12.5, lineHeight: 1.4 }}>
                <span style={{ color: 'var(--text-primary)', fontWeight: 500 }}>{row.label}</span>
                <span style={{ color: 'var(--text-muted)', fontSize: 11 }}> — {row.detail}</span>
              </span>
              <Cell on={row.harness} />
              <Cell on={row.baseline} />
            </div>
          ))}
        </Fragment>
      ))}
    </div>
  )
}

// Dedicated page (reached from the setup screen) so the full comparison has room
// to breathe instead of cluttering the benchmark config form.
function ArmComparisonPage({ onBack }: { onBack: () => void }) {
  return (
    <div style={{ flex: 1, overflow: 'auto', padding: '20px 22px 56px', display: 'flex', justifyContent: 'center' }}>
      <div style={{ width: 'min(820px, 100%)' }}>
        <button
          type="button"
          onClick={onBack}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: 'transparent', border: 'none', color: 'var(--text-secondary)', fontSize: 12, cursor: 'pointer', padding: '4px 0', marginBottom: 14 }}
        >
          <span aria-hidden>←</span> Back to setup
        </button>
        <div style={{ fontSize: 18, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 6 }}>How the two arms differ</div>
        <div style={{ fontSize: 12.5, color: 'var(--text-muted)', lineHeight: 1.6, marginBottom: 18, maxWidth: 640 }}>
          Both arms run the same agent against the same frozen bug with the same tooling. The benchmark isolates a{' '}
          <b style={{ color: 'var(--text-secondary)' }}>single variable</b> — canary-lab’s curated &amp; captured
          failure context — so any speed or success-rate gap is attributable to that context alone.
        </div>
        <ArmMatrixTable />
      </div>
    </div>
  )
}

export function BenchmarkWindow({ onClose }: { onClose: () => void }) {
  const { startBenchmark, benchmarks } = useBenchmarks()
  // Resume ONLY a live benchmark (so you don't lose a run in progress); when
  // nothing is running, open on the config/sabotage screen — clicking Benchmark
  // should start a fresh one, not resurface a finished/aborted run.
  // (benchmarks are sorted newest-first by the reducer.)
  const live = benchmarks.find(
    (b) => b.status === 'sabotaging' || b.status === 'ready' || b.status === 'running',
  )
  const [activeId, setActiveId] = useState<string | null>(live?.benchmarkId ?? null)
  const blocked = !!live

  return (
    // Full-screen, mirroring the Add Test wizard (fixed inset-0) — the benchmark
    // is a focused workspace, not a floating modal.
    <div className="fixed inset-0 z-[60] flex flex-col" style={{ background: 'var(--bg-base)' }}>
      {activeId ? (
        <BenchmarkDetail id={activeId} onClose={onClose} onNew={() => setActiveId(null)} />
      ) : (
        <ConfigScreen onClose={onClose} onStarted={setActiveId} startBenchmark={startBenchmark} blocked={blocked} />
      )}
    </div>
  )
}

// ─── Config ────────────────────────────────────────────────────────────────

function ConfigScreen({
  onClose,
  onStarted,
  startBenchmark,
  blocked,
}: {
  onClose: () => void
  onStarted: (id: string) => void
  startBenchmark: ReturnType<typeof useBenchmarks>['startBenchmark']
  blocked: boolean
}) {
  const [features, setFeatures] = useState<Feature[]>([])
  const [feature, setFeature] = useState<string>('')
  const [skills, setSkills] = useState<SabotageSkillSummary[]>([])
  const [skill, setSkill] = useState<string>('')
  const [iterations, setIterations] = useState(2)
  const [agent, setAgent] = useState<'claude' | 'codex'>('claude')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [view, setView] = useState<'setup' | 'arms'>('setup')

  useEffect(() => {
    api.listFeatures().then((f) => {
      setFeatures(f)
      if (f.length && !feature) setFeature(f[0].name)
    }).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!feature) return
    api.listSabotageSkills(feature).then((s) => {
      setSkills(s)
      // Keep the current pick if the new feature still offers it (skills are
      // generic, so it usually does) — only fall back to the first otherwise.
      setSkill((prev) => (s.some((x) => x.name === prev) ? prev : s[0]?.name ?? ''))
    }).catch(() => setSkills([]))
  }, [feature])

  const selected = skills.find((s) => s.name === skill)

  const start = async () => {
    if (!feature || !selected) return
    setBusy(true); setError(null)
    try {
      const id = await startBenchmark({ feature, skill: selected.name, level: selected.level, iterations, agent })
      onStarted(id)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  if (view === 'arms') {
    return (
      <>
        <BenchmarkHeader stage={0} title="How the arms differ" onClose={onClose} />
        <ArmComparisonPage onBack={() => setView('setup')} />
      </>
    )
  }

  return (
    <>
      <BenchmarkHeader stage={0} title="New benchmark" onClose={onClose} />
      <div style={{ flex: 1, overflow: 'auto', padding: '24px 22px 56px', display: 'flex', justifyContent: 'center' }}>
        <div style={{ width: 'min(720px, 100%)' }}>
          <Label>Sabotage skill</Label>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
            {skills.map((s) => (
              <div
                key={s.name}
                onClick={() => setSkill(s.name)}
                style={{
                  border: `1px solid ${skill === s.name ? 'var(--accent)' : 'var(--border-default)'}`,
                  background: skill === s.name ? 'var(--accent-soft)' : 'transparent',
                  borderRadius: 'var(--radius-lg)', padding: 13, cursor: 'pointer',
                }}
              >
                <span style={{
                  fontSize: 9.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.5px',
                  padding: '2px 8px', borderRadius: 9999, ...badgeStyle(s.level),
                }}>{s.level}</span>
                <div style={{ fontWeight: 600, fontSize: 13, marginTop: 8 }}>{s.title}</div>
                <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 4, lineHeight: 1.45 }}>{s.summary}</div>
              </div>
            ))}
            {skills.length === 0 && (
              <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>
                No sabotage skills for this feature. Run <span style={{ fontFamily: 'var(--font-mono)' }}>canary-lab upgrade</span> or add skills under <span style={{ fontFamily: 'var(--font-mono)' }}>sabotage-skills/</span>.
              </div>
            )}
          </div>

          {selected && (
            <>
              <Label style={{ marginTop: 16 }}>What the sabotage agent is told</Label>
              <div style={{
                background: 'var(--bg-base)', border: '1px solid var(--border-default)',
                borderRadius: 'var(--radius-md)', padding: '11px 13px', fontSize: 11.5,
                color: 'var(--text-secondary)', lineHeight: 1.55, whiteSpace: 'pre-wrap',
                fontFamily: 'var(--font-mono)', maxHeight: 220, overflow: 'auto',
              }}>{selected.recipe}</div>
            </>
          )}

          <Field label="Feature">
            <select value={feature} onChange={(e) => setFeature(e.target.value)} style={selectStyle}>
              {features.map((f) => <option key={f.name} value={f.name}>{f.name}</option>)}
            </select>
          </Field>

          <Field label="Heal agent">
            <div style={{ display: 'inline-flex', border: '1px solid var(--border-default)', borderRadius: 'var(--radius-md)', overflow: 'hidden', height: 34 }}>
              {(['claude', 'codex'] as const).map((a, i) => (
                <button
                  key={a}
                  type="button"
                  onClick={() => setAgent(a)}
                  aria-pressed={agent === a}
                  style={{
                    border: 'none', cursor: 'pointer', padding: '0 16px', fontSize: 12, fontWeight: 500,
                    fontFamily: 'var(--font-mono)', textTransform: 'capitalize',
                    borderLeft: i === 1 ? '1px solid var(--border-default)' : 'none',
                    background: agent === a ? 'var(--accent-soft)' : 'var(--bg-input)',
                    color: agent === a ? 'var(--accent)' : 'var(--text-secondary)',
                  }}
                >
                  {a}
                </button>
              ))}
            </div>
            <span style={{ color: 'var(--text-muted)', fontSize: 11.5, marginLeft: 12 }}>
              both arms use this CLI · independent of your global heal setting
            </span>
          </Field>

          <Field label="Iterations">
            <div style={{ display: 'inline-flex', alignItems: 'center', border: '1px solid var(--border-default)', borderRadius: 'var(--radius-md)', overflow: 'hidden', height: 34 }}>
              <Stepper onClick={() => setIterations((n) => Math.max(1, n - 1))}>−</Stepper>
              <div style={{ width: 48, textAlign: 'center', fontFamily: 'var(--font-mono)', fontSize: 13, borderLeft: '1px solid var(--border-default)', borderRight: '1px solid var(--border-default)', height: '100%', display: 'grid', placeItems: 'center', background: 'var(--bg-input)' }}>{iterations}</div>
              <Stepper onClick={() => setIterations((n) => Math.min(5, n + 1))}>+</Stepper>
            </div>
            <span style={{ color: 'var(--text-muted)', fontSize: 11.5, marginLeft: 12 }}>same frozen bug, repeated → variance</span>
          </Field>

          <button
            type="button"
            onClick={() => setView('arms')}
            style={{
              display: 'flex', alignItems: 'baseline', gap: 8, width: '100%', textAlign: 'left',
              background: 'transparent', border: 'none', padding: '2px 0', marginTop: 18, cursor: 'pointer',
            }}
          >
            <span style={{ fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '.4px', color: 'var(--text-muted)', fontWeight: 600, flex: 'none' }}>
              What each arm gets
            </span>
            <span style={{ flex: 1, minWidth: 0, fontSize: 11, color: 'var(--text-muted)', opacity: 0.75, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              — only canary-lab’s curated failure context differs
            </span>
            <span aria-hidden style={{ fontSize: 11, color: 'var(--accent)', flex: 'none', fontWeight: 600 }}>Compare →</span>
          </button>

          {error && <div style={{ color: 'rgb(251,113,133)', fontSize: 12, marginTop: 10 }}>{error}</div>}

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 22, paddingTop: 16, borderTop: '1px solid var(--border-default)' }}>
            <span style={{ color: blocked ? 'rgb(251,191,36)' : 'var(--text-muted)', fontSize: 11.5 }}>
              {blocked
                ? 'A benchmark is already running — stop it before starting another.'
                : 'Both arms get the identical frozen break · tests stay read-only'}
            </span>
            <button className="cl-button-primary" disabled={busy || !selected || blocked} onClick={start} style={{ padding: '8px 15px' }}>
              {busy ? 'Starting…' : 'Start benchmark ▶'}
            </button>
          </div>
        </div>
      </div>
    </>
  )
}

// ─── Detail (setup / race / report) ─────────────────────────────────────────

function BenchmarkDetail({ id, onClose, onNew }: { id: string; onClose: () => void; onNew: () => void }) {
  const m = useBenchmark(id)
  const { abortBenchmark, loadBenchmark } = useBenchmarks()
  const [tab, setTab] = useState<'race' | 'report'>('race')
  const [armFocus, setArmFocus] = useState<BenchmarkArm>('A')

  // The WS snapshot only carries details for ACTIVE benchmarks, so a terminal
  // one (resumed on open, or any finished run) won't be in `details` and no
  // `update` will ever arrive for it — fetch its manifest once to hydrate.
  useEffect(() => {
    if (!m) void loadBenchmark(id)
  }, [id, m, loadBenchmark])

  // When the run reaches a terminal state, land on the Report (the payoff) —
  // once, on the transition, so a manual switch back to Race is respected.
  const prevStatus = useRef<string | undefined>(undefined)
  useEffect(() => {
    const s = m?.status
    if (s && isTerminal(s) && !isTerminal(prevStatus.current)) setTab('report')
    prevStatus.current = s
  }, [m?.status])

  if (!m) {
    return (<><BenchmarkHeader stage={1} title="Benchmark" onClose={onClose} /><Centered>Loading…</Centered></>)
  }

  const sabotaging = m.status === 'sabotaging' || m.status === 'ready'

  return (
    <>
      <BenchmarkHeader
        stage={lifecycleStage(m.status)}
        status={m.status}
        title={m.benchmarkId}
        view={tab}
        onSelectView={setTab}
        iteration={Math.max(1, m.currentIteration)}
        totalIterations={m.iterations}
        onStop={
          m.status === 'sabotaging' || m.status === 'running'
            ? () => {
                if (window.confirm('Stop this benchmark? Both arms will be aborted.')) void abortBenchmark(m.benchmarkId)
              }
            : undefined
        }
        onNew={onNew}
        onClose={onClose}
      />
      <div style={{ flex: 1, overflow: 'auto', padding: 18 }}>
        {sabotaging ? (
          <SetupView m={m} />
        ) : m.status === 'error' ? (
          <div style={{ color: 'rgb(251,113,133)', fontSize: 13 }}>Benchmark error: {m.error}</div>
        ) : tab === 'report' ? (
          <ReportView m={m} />
        ) : (
          <RaceView m={m} armFocus={armFocus} setArmFocus={setArmFocus} />
        )}
      </div>
    </>
  )
}

function SetupView({ m }: { m: BenchmarkManifest }) {
  const [elapsed, setElapsed] = useState(0)

  useEffect(() => {
    const start = new Date(m.startedAt).getTime()
    const tick = () => setElapsed(Math.max(0, Math.round((Date.now() - start) / 1000)))
    tick()
    const t = setInterval(tick, 1000)
    return () => clearInterval(t)
  }, [m.startedAt])

  return (
    <div style={{ color: 'var(--text-secondary)', fontSize: 13, maxWidth: 980, display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <span className="animate-pulse" style={{ width: 9, height: 9, borderRadius: 9999, background: 'rgb(251,191,36)', flex: 'none' }} />
        <span>
          Sabotaging <span style={{ fontFamily: 'var(--font-mono)' }}>{m.feature}</span> with the <b>{m.level}</b> skill…{' '}
          <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>{elapsed}s</span>
        </span>
      </div>
      <div style={{ color: 'var(--text-muted)', fontSize: 12, lineHeight: 1.6, marginBottom: 14 }}>
        The sabotage agent is editing the app code in an isolated worktree — this usually takes <b>30–90s</b>.
        When the broken state is frozen, both arms (🐤 harness, ⚙ baseline) start automatically and the race appears here.
      </div>
      <div style={{ fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '.4px', color: 'var(--text-muted)', marginBottom: 7, fontWeight: 600 }}>Sabotage agent</div>
      <div style={{ flex: 1, minHeight: 200, border: '1px solid var(--border-default)', borderRadius: 'var(--radius-lg)', overflow: 'hidden' }}>
        {m.agent === 'codex'
          ? <CodexSabotageLog benchmarkId={m.benchmarkId} />
          : <AgentSessionView source={{ kind: 'benchmark', benchmarkId: m.benchmarkId, live: true }} />}
      </div>
    </div>
  )
}

// Codex doesn't write a locatable native session log we can feed to
// AgentSessionView, so it keeps the simple tailed-text view.
function CodexSabotageLog({ benchmarkId }: { benchmarkId: string }) {
  const [log, setLog] = useState('')
  const logRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let cancelled = false
    const poll = () => {
      api.getBenchmarkSabotageLog(benchmarkId).then((r) => { if (!cancelled) setLog(r.log) }).catch(() => {})
    }
    poll()
    const t = setInterval(poll, 1500)
    return () => { cancelled = true; clearInterval(t) }
  }, [benchmarkId])
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [log])
  return (
    <div
      ref={logRef}
      style={{
        fontFamily: 'var(--font-mono)', fontSize: 11.5, background: '#000', height: '100%',
        padding: '11px 13px', lineHeight: 1.6, whiteSpace: 'pre-wrap', color: '#cfd6dd', overflow: 'auto',
      }}
    >
      {log || 'Waiting for the sabotage agent to start…'}
    </div>
  )
}

function RaceView({ m, armFocus, setArmFocus }: { m: BenchmarkManifest; armFocus: BenchmarkArm; setArmFocus: (a: BenchmarkArm) => void }) {
  const armRunId = useMemo(() => {
    const arm = m.arms.find((a) => a.arm === armFocus)
    return arm?.runIds[arm.runIds.length - 1] ?? null
  }, [m, armFocus])

  return (
    <>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
        {(['A', 'B'] as const).map((arm) => (
          <ArmCard key={arm} m={m} arm={arm} focused={armFocus === arm} onClick={() => setArmFocus(arm)} />
        ))}
      </div>
      <div style={{ display: 'inline-flex', border: '1px solid var(--border-default)', borderRadius: 'var(--radius-md)', overflow: 'hidden', marginBottom: 11 }}>
        {(['A', 'B'] as const).map((arm) => (
          <button key={arm} onClick={() => setArmFocus(arm)} style={{
            background: armFocus === arm ? 'var(--bg-selected)' : 'var(--bg-surface)',
            color: armFocus === arm ? 'var(--text-primary)' : 'var(--text-secondary)',
            border: 'none', borderRight: arm === 'A' ? '1px solid var(--border-default)' : 'none',
            padding: '7px 15px', fontSize: 12, fontWeight: 500, cursor: 'pointer',
          }}>{arm === 'A' ? '🐤 Harness arm' : '⚙ Baseline arm'}</button>
        ))}
      </div>
      <div style={{ border: '1px solid var(--border-default)', borderRadius: 'var(--radius-lg)', overflow: 'hidden', height: 460 }}>
        <RunDetailColumn runId={armRunId} />
      </div>
    </>
  )
}

function ArmCard({ m, arm, focused, onClick }: { m: BenchmarkManifest; arm: BenchmarkArm; focused: boolean; onClick: () => void }) {
  const isHarness = arm === 'A'
  const results = m.results.filter((r) => r.arm === arm)
  const last = results[results.length - 1]
  const status = last ? (last.healed ? '✓ healed' : '✗ failed') : m.status === 'running' ? 'running…' : 'waiting…'
  const statusColor = last ? (last.healed ? 'rgb(52,211,153)' : 'rgb(251,113,133)') : 'var(--text-muted)'
  return (
    <div onClick={onClick} style={{
      border: `1px solid ${focused ? (isHarness ? 'var(--boot)' : 'var(--accent)') : 'var(--border-default)'}`,
      boxShadow: focused ? `0 0 0 1px ${isHarness ? 'var(--boot)' : 'var(--accent)'}` : 'none',
      borderRadius: 'var(--radius-lg)', padding: '14px 16px', cursor: 'pointer', background: 'var(--bg-surface)',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontWeight: 600, fontSize: 13.5 }}>
        <span style={{ color: isHarness ? 'var(--boot)' : 'var(--text-primary)' }}>{isHarness ? '🐤 Harness arm' : '⚙ Baseline arm'}</span>
        <span style={{ fontSize: 11.5, fontWeight: 600, color: statusColor }}>{status}</span>
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
        {isHarness ? 'claude · sliced logs · trace-extracts · journal' : 'claude · Playwright MCP + trace only'}
      </div>
      <div style={{ display: 'flex', gap: 15, fontSize: 11, color: 'var(--text-muted)', marginTop: 10 }}>
        <span>cycles <b style={{ color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}>{last?.healCycles ?? '–'}</b></span>
        <span>time <b style={{ color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}>{last ? `${Math.round(last.wallClockMs / 1000)}s` : '–'}</b></span>
      </div>
    </div>
  )
}

function ReportView({ m }: { m: BenchmarkManifest }) {
  const rep = m.report
  const iters = useMemo(() => {
    const map = new Map<number, { A?: typeof m.results[number]; B?: typeof m.results[number] }>()
    for (const r of m.results) {
      const e = map.get(r.iteration) ?? {}
      e[r.arm] = r
      map.set(r.iteration, e)
    }
    return [...map.entries()].sort((a, b) => a[0] - b[0])
  }, [m.results])
  if (!rep) return <Centered>No report yet.</Centered>
  const headline = rep.reliabilityMultiple != null
    ? `${rep.reliabilityMultiple.toFixed(1)}× more reliable repair`
    : rep.baseline.iterationsHealed === 0 && rep.harness.iterationsHealed > 0
      ? 'Harness healed where the baseline never could'
      : 'Comparison'
  return (
    <div style={{ maxWidth: 760 }}>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 10 }}>
        <button
          className="cl-button"
          style={{ padding: '6px 12px' }}
          onClick={() => downloadText(`${m.benchmarkId}.md`, benchmarkReportMarkdown(m, headline), 'text/markdown')}
        >
          ⬇ Export report
        </button>
      </div>
      <div style={{ border: '1px solid color-mix(in srgb, rgb(52,211,153) 45%, var(--border-default))', background: 'rgba(16,185,129,0.07)', borderRadius: 'var(--radius-xl)', padding: '18px 20px', marginBottom: 16 }}>
        <div style={{ fontSize: 24, fontWeight: 700, color: 'rgb(52,211,153)', lineHeight: 1 }}>{headline}</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 16 }}>
          <StatCard label="🐤 Harness arm" accent="var(--boot)" color="rgb(52,211,153)" s={rep.harness} />
          <StatCard label="⚙ Baseline arm" accent="var(--border-default)" color="rgb(251,191,36)" s={rep.baseline} />
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 12 }}>
          sabotage <span style={{ fontFamily: 'var(--font-mono)' }}>{m.sabotageSha?.slice(0, 7)}</span> · model <span style={{ fontFamily: 'var(--font-mono)' }}>{m.agent} (pinned)</span> · tests read-only ✓
        </div>
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, border: '1px solid var(--border-default)', borderRadius: 'var(--radius-lg)', overflow: 'hidden' }}>
        <thead><tr>{['Iter', '🐤 harness', 'cycles', 'time', '⚙ baseline', 'cycles', 'time'].map((h, i) => (
          <th key={h} style={{ textAlign: i === 0 ? 'left' : 'right', padding: '9px 12px', background: 'var(--bg-elevated)', color: 'var(--text-muted)', fontSize: 10, textTransform: 'uppercase', letterSpacing: '.4px', fontWeight: 600, borderBottom: '1px solid var(--border-default)' }}>{h}</th>
        ))}</tr></thead>
        <tbody>
          {iters.map(([n, e]) => (
            <tr key={n}>
              <td style={cell()}>#{n}</td>
              <td style={cell(true, e.A?.healed ? 'rgb(52,211,153)' : 'rgb(251,113,133)')}>{e.A ? (e.A.healed ? '✓ healed' : '✗ failed') : '—'}</td>
              <td style={cell(true)}>{e.A?.healCycles ?? '—'}</td>
              <td style={cell(true)}>{e.A ? `${Math.round(e.A.wallClockMs / 1000)}s` : '—'}</td>
              <td style={cell(true, e.B?.healed ? 'rgb(52,211,153)' : 'rgb(251,113,133)')}>{e.B ? (e.B.healed ? '✓ healed' : '✗ failed') : '—'}</td>
              <td style={cell(true)}>{e.B?.healCycles ?? '—'}</td>
              <td style={cell(true)}>{e.B ? `${Math.round(e.B.wallClockMs / 1000)}s` : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function StatCard({ label, accent, color, s }: { label: string; accent: string; color: string; s: { iterationsHealed: number; iterationsTotal: number; avgHealCycles: number; totalWallClockMs: number } }) {
  return (
    <div style={{ border: `1px solid ${accent}`, borderRadius: 'var(--radius-lg)', padding: '13px 15px', background: 'rgba(127,127,127,0.05)' }}>
      <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8 }}>{label}</div>
      <div style={{ fontSize: 26, fontWeight: 700, fontFamily: 'var(--font-mono)', lineHeight: 1, color }}>
        {s.iterationsHealed}/{s.iterationsTotal} <small style={{ fontSize: 12, fontWeight: 500, fontFamily: 'var(--font-sans)', color: 'var(--text-muted)' }}>healed</small>
      </div>
      <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 8 }}>
        avg <b style={{ color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}>{s.avgHealCycles.toFixed(1)}</b> cycles · <b style={{ color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}>{Math.round(s.totalWallClockMs / 1000)}s</b>
      </div>
    </div>
  )
}

// ─── small helpers ───────────────────────────────────────────────────────────

/** Trigger a client-side file download (no server round-trip). */
function downloadText(filename: string, text: string, mime: string): void {
  const blob = new Blob([text], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

/** Render the benchmark report as a shareable markdown artifact. */
function benchmarkReportMarkdown(m: BenchmarkManifest, headline: string): string {
  const rep = m.report
  const secs = (ms: number) => `${Math.round(ms / 1000)}s`
  const lines: string[] = []
  lines.push(`# Canary Lab Benchmark — \`${m.feature}\` (${m.level} sabotage)`)
  lines.push('')
  if (rep) {
    lines.push(`**${headline}**`)
    lines.push('')
    lines.push('| Arm | Healed | Avg cycles | Total time |')
    lines.push('| --- | --- | --- | --- |')
    lines.push(`| 🐤 Harness | ${rep.harness.iterationsHealed}/${rep.harness.iterationsTotal} | ${rep.harness.avgHealCycles.toFixed(1)} | ${secs(rep.harness.totalWallClockMs)} |`)
    lines.push(`| ⚙ Baseline | ${rep.baseline.iterationsHealed}/${rep.baseline.iterationsTotal} | ${rep.baseline.avgHealCycles.toFixed(1)} | ${secs(rep.baseline.totalWallClockMs)} |`)
    lines.push('')
  }
  lines.push(`Sabotage \`${m.sabotageSha?.slice(0, 7) ?? '—'}\` · skill \`${m.skill}\` · model \`${m.agent}\` (pinned) · tests read-only ✓`)
  lines.push('')
  lines.push('## Per-iteration')
  lines.push('')
  lines.push('| Iter | Harness | cycles | time | Baseline | cycles | time |')
  lines.push('| --- | --- | --- | --- | --- | --- | --- |')
  const byIter = new Map<number, { A?: typeof m.results[number]; B?: typeof m.results[number] }>()
  for (const r of m.results) {
    const e = byIter.get(r.iteration) ?? {}
    e[r.arm] = r
    byIter.set(r.iteration, e)
  }
  for (const [n, e] of [...byIter.entries()].sort((a, b) => a[0] - b[0])) {
    const cell = (r?: typeof m.results[number]) =>
      r ? `${r.healed ? '✓ healed' : '✗ failed'} | ${r.healCycles} | ${secs(r.wallClockMs)}` : '— | — | —'
    lines.push(`| #${n} | ${cell(e.A)} | ${cell(e.B)} |`)
  }
  lines.push('')
  lines.push(`_Generated by Canary Lab · benchmark \`${m.benchmarkId}\`_`)
  return lines.join('\n') + '\n'
}

// Lifecycle → stepper index. 0 Sabotage (config) · 1 Progress (sabotaging) ·
// 2 Race (running) · 3 Report (terminal).
function lifecycleStage(status?: BenchmarkManifest['status']): number {
  if (!status) return 0
  if (status === 'sabotaging' || status === 'ready') return 1
  if (status === 'running') return 2
  return 3
}
function isTerminal(status?: string): boolean {
  return status === 'done' || status === 'aborted' || status === 'error'
}

const STAGE_LABELS = ['Sabotage', 'Progress', 'Race', 'Report'] as const

// The journey indicator: Sabotage → Progress → Race → Report. The current stage
// is filled, completed stages get a check, upcoming ones stay muted. Race and
// Report become clickable once reachable, so the stepper doubles as the view
// switcher (replacing the old Race/Report tabs).
function StageStepper({
  stage,
  status,
  view,
  onSelectView,
}: {
  stage: number
  status?: BenchmarkManifest['status']
  view?: 'race' | 'report'
  onSelectView?: (v: 'race' | 'report') => void
}) {
  const activeIndex = stage <= 1 ? stage : stage === 2 ? 2 : view === 'report' ? 3 : 2
  return (
    <div style={{ display: 'flex', alignItems: 'center', minWidth: 0 }}>
      {STAGE_LABELS.map((label, i) => {
        const reached = i <= stage
        const done = i < stage
        const isActive = i === activeIndex
        const clickable = !!onSelectView && ((i === 2 && stage >= 2) || (i === 3 && stage >= 3))
        const pulse = isActive && ((i === 1 && status === 'sabotaging') || (i === 2 && status === 'running'))
        return (
          <Fragment key={label}>
            {i > 0 && (
              <span
                aria-hidden="true"
                style={{
                  width: 24, height: 2, borderRadius: 2, margin: '0 8px', flex: 'none',
                  background: i <= stage ? 'var(--accent)' : 'var(--border-default)',
                  opacity: i <= stage ? 0.75 : 1, transition: 'background 240ms ease',
                }}
              />
            )}
            <span
              onClick={clickable ? () => onSelectView!(i === 3 ? 'report' : 'race') : undefined}
              title={clickable ? `View ${label.toLowerCase()}` : undefined}
              aria-current={isActive ? 'step' : undefined}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 7, cursor: clickable ? 'pointer' : 'default', userSelect: 'none' }}
            >
              <span
                className={pulse ? 'animate-pulse' : undefined}
                style={{
                  width: 18, height: 18, borderRadius: 9999, display: 'grid', placeItems: 'center',
                  fontSize: 10, fontWeight: 700, flex: 'none',
                  border: `1.5px solid ${reached ? 'var(--accent)' : 'var(--border-default)'}`,
                  background: isActive ? 'var(--accent)' : done ? 'var(--accent-soft)' : 'transparent',
                  color: isActive ? 'var(--bg-base)' : reached ? 'var(--accent)' : 'var(--text-muted)',
                  boxShadow: isActive ? '0 0 0 3px color-mix(in srgb, var(--accent) 16%, transparent)' : 'none',
                  transition: 'background 200ms ease, color 200ms ease, border-color 200ms ease, box-shadow 200ms ease',
                }}
              >
                {done ? '✓' : i + 1}
              </span>
              <span
                style={{
                  fontSize: 12, fontWeight: isActive ? 600 : 500,
                  color: isActive ? 'var(--text-primary)' : reached ? 'var(--text-secondary)' : 'var(--text-muted)',
                  transition: 'color 200ms ease', whiteSpace: 'nowrap',
                }}
              >
                {label}
              </span>
            </span>
          </Fragment>
        )
      })}
    </div>
  )
}

// Unified window header: identity + actions row over the stage stepper row.
// Shared by the config screen (stage 0) and the live detail view.
function BenchmarkHeader({
  stage,
  status,
  title,
  view,
  onSelectView,
  iteration,
  totalIterations,
  onStop,
  onNew,
  onClose,
}: {
  stage: number
  status?: BenchmarkManifest['status']
  title: string
  view?: 'race' | 'report'
  onSelectView?: (v: 'race' | 'report') => void
  iteration?: number
  totalIterations?: number
  onStop?: () => void
  onNew?: () => void
  onClose: () => void
}) {
  const active = status === 'sabotaging' || status === 'ready' || status === 'running'
  const dot = !status
    ? 'var(--accent)'
    : status === 'done'
      ? 'var(--accent)'
      : status === 'error' || status === 'aborted'
        ? 'rgb(251,113,133)'
        : 'rgb(56,189,248)'
  return (
    <div style={{ borderBottom: '1px solid var(--border-default)', background: 'var(--bg-surface)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px 8px' }}>
        <span style={{ width: 9, height: 9, borderRadius: 9999, background: dot, flex: 'none' }} />
        <span
          style={{
            fontFamily: 'var(--font-mono)', fontSize: 13, whiteSpace: 'nowrap',
            overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 360,
          }}
        >
          {title}
        </span>
        <span
          style={{
            fontSize: 9.5, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.4px',
            padding: '2px 7px', borderRadius: 'var(--radius-sm)', background: 'var(--accent-soft)',
            color: 'var(--accent)', flex: 'none',
          }}
        >
          Benchmark
        </span>
        <span style={{ flex: '1 1 auto' }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {onStop && (
            <button
              className="cl-button"
              style={{ padding: '6px 12px', color: 'rgb(251,113,133)', borderColor: 'color-mix(in srgb, rgb(251,113,133) 45%, var(--border-default))' }}
              onClick={onStop}
            >
              ■ Stop
            </button>
          )}
          {onNew && !active && (
            <button className="cl-button" style={{ padding: '6px 12px' }} onClick={onNew}>＋ New</button>
          )}
          <button className="cl-button" style={{ padding: '6px 12px' }} onClick={onClose}>Close ✕</button>
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '2px 16px 11px' }}>
        <StageStepper stage={stage} status={status} view={view} onSelectView={onSelectView} />
        <span style={{ flex: '1 1 auto' }} />
        {iteration != null && totalIterations != null && stage >= 2 && view === 'race' && (
          <span
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 10px',
              border: '1px solid var(--border-default)', borderRadius: 9999, fontSize: 11, color: 'var(--text-muted)', flex: 'none',
            }}
          >
            Iteration <b style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-primary)' }}>{iteration}</b> /{' '}
            <span style={{ fontFamily: 'var(--font-mono)' }}>{totalIterations}</span>
          </span>
        )}
      </div>
    </div>
  )
}
function Centered({ children }: { children: React.ReactNode }) {
  return <div style={{ height: '100%', display: 'grid', placeItems: 'center', color: 'var(--text-muted)', fontSize: 13 }}>{children}</div>
}
function Label({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return <div style={{ fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '.4px', color: 'var(--text-muted)', margin: '6px 0 8px', fontWeight: 600, ...style }}>{children}</div>
}
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '14px 0' }}>
      <label style={{ width: 90, color: 'var(--text-secondary)', fontSize: 12 }}>{label}</label>
      {children}
    </div>
  )
}
function Stepper({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return <button onClick={onClick} style={{ background: 'var(--bg-surface)', border: 'none', color: 'var(--text-primary)', width: 36, height: '100%', cursor: 'pointer', fontSize: 18 }}>{children}</button>
}
function badgeStyle(level: SabotageLevel): React.CSSProperties {
  const b = LEVEL_BADGE[level]
  return { background: b.bg, color: b.fg }
}
function cell(right = false, color?: string): React.CSSProperties {
  return { textAlign: right ? 'right' : 'left', padding: '9px 12px', borderBottom: '1px solid var(--border-default)', fontFamily: right ? 'var(--font-mono)' : undefined, color }
}
const selectStyle: React.CSSProperties = { background: 'var(--bg-input)', border: '1px solid var(--border-default)', color: 'var(--text-primary)', borderRadius: 'var(--radius-md)', padding: '7px 10px', fontSize: 12 }
