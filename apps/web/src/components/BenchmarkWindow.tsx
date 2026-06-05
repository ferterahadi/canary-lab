import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import * as api from '../api/client'
import type { Feature } from '../api/types'
import type { BenchmarkArm, BenchmarkManifest, BenchmarkReport, SabotageLevel, SabotageSkillSummary } from '../api/benchmark-types'
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
    section: 'Canary Lab failure context — harness only',
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
    // alignItems:flex-start: see ConfigScreen — default `stretch` would pin
    // this child to the visible height and swallow the bottom padding.
    <div style={{ flex: 1, overflow: 'auto', padding: '20px 22px 96px', display: 'flex', justifyContent: 'center', alignItems: 'flex-start' }}>
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
      {/* alignItems:flex-start is load-bearing: without it the default `stretch`
          pins this row-flex child to the container's *visible* height, so its
          content overflows past the scroll region and the bottom padding (the
          space under the Start-benchmark footer) is swallowed. flex-start lets
          the child grow to content+padding so the footer gets real breathing room. */}
      <div style={{ flex: 1, overflow: 'auto', padding: '24px 22px 96px', display: 'flex', justifyContent: 'center', alignItems: 'flex-start' }}>
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
            <select
              value={feature}
              onChange={(e) => {
                // The start error (e.g. "uncommitted changes") is specific to
                // the feature that was attempted — switching feature makes it
                // stale, so drop it on change.
                setError(null)
                setFeature(e.target.value)
              }}
              style={selectStyle}
            >
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
        {m.sabotageSha && !sabotaging && m.status !== 'error' && (
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
            <button
              type="button"
              className="cl-button"
              title="Open a pristine checkout of the frozen (destroyed) code in your editor"
              onClick={() => void openWorktreeAction(m.benchmarkId, 'frozen')}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '6px 12px', fontSize: 12 }}
            >
              <OpenEditorIcon /> Open frozen bug
            </button>
          </div>
        )}
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
  const focusArm = m.arms.find((a) => a.arm === armFocus)
  const armRunId = focusArm?.runIds[focusArm.runIds.length - 1] ?? null
  const isHarness = armFocus === 'A'
  const accent = isHarness ? 'var(--boot)' : 'var(--accent)'
  const armLabel = isHarness ? '🐤 Harness arm' : '⚙ Baseline arm'

  return (
    <>
      {/* The cards ARE the arm selector — click one to focus it; the focused
          card carries an accent ring and drives the run detail below. We used
          to render a second pill toggle here with the same two labels, but it
          just duplicated the card headers, so it's gone. */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 14 }}>
        {(['A', 'B'] as const).map((arm) => (
          <ArmCard key={arm} m={m} arm={arm} focused={armFocus === arm} onClick={() => setArmFocus(arm)} />
        ))}
      </div>
      <div style={{ border: '1px solid var(--border-default)', borderRadius: 'var(--radius-lg)', overflow: 'hidden', height: 460, display: 'flex', flexDirection: 'column' }}>
        {/* Header strip names the arm whose run is shown — the identity moved
            here (a label for the panel) instead of a redundant toggle. */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flex: 'none',
          padding: '8px 12px', borderBottom: '1px solid var(--border-default)',
          background: `color-mix(in srgb, ${accent} 7%, var(--bg-surface))`,
        }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 12, fontWeight: 600, minWidth: 0 }}>
            <span style={{ width: 7, height: 7, borderRadius: 9999, background: accent, flex: 'none' }} />
            <span style={{ color: accent }}>{armLabel}</span>
            <span style={{ color: 'var(--text-muted)', fontWeight: 500 }}>· run detail</span>
          </span>
          <span style={{ fontSize: 10.5, color: 'var(--text-muted)', flex: 'none', whiteSpace: 'nowrap' }}>
            click an arm above to switch
          </span>
        </div>
        <div style={{ flex: 1, minHeight: 0 }}>
          {armRunId
            ? <RunDetailColumn runId={armRunId} />
            : <ArmEmptyState arm={armFocus} accent={accent} status={m.status} />}
        </div>
      </div>
    </>
  )
}

// Benchmark-aware placeholder for the run-detail panel before an arm has any
// run. Replaces RunDetailColumn's generic "Select a run" void, which was both
// ugly (a 460px empty box) and misleading here — a card is always focused, the
// arm just hasn't produced a run yet.
function ArmEmptyState({ arm, accent, status }: { arm: BenchmarkArm; accent: string; status: BenchmarkManifest['status'] }) {
  const isHarness = arm === 'A'
  const label = isHarness ? 'Harness arm' : 'Baseline arm'
  const emoji = isHarness ? '🐤' : '⚙'
  const waiting = status === 'running' || status === 'sabotaging' || status === 'ready'
  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 11, padding: 24, textAlign: 'center' }}>
      <div style={{
        width: 46, height: 46, borderRadius: 9999, display: 'grid', placeItems: 'center', fontSize: 22,
        background: `color-mix(in srgb, ${accent} 13%, transparent)`,
        border: `1px solid color-mix(in srgb, ${accent} 34%, transparent)`,
      }}>{emoji}</div>
      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>No run for the {label} yet</div>
      <div style={{ fontSize: 11.5, color: 'var(--text-muted)', maxWidth: 300, lineHeight: 1.5 }}>
        {waiting
          ? 'Its run streams in here the moment this arm starts — sabotage finishes first, then both arms race.'
          : 'This arm never produced a run.'}
      </div>
    </div>
  )
}

// Open a benchmark worktree in the user's editor. Best-effort: if the editor
// couldn't be launched, surface the path so it can be opened by hand.
async function openWorktreeAction(id: string, target: 'frozen' | 'A' | 'B'): Promise<void> {
  try {
    const r = await api.openBenchmarkWorktree(id, target)
    if (!r.opened) {
      window.prompt('Could not launch your editor automatically — copy this path:', r.path)
    }
  } catch (e) {
    window.alert(e instanceof Error ? e.message : String(e))
  }
}

// Small "open in editor" affordance (↗ in a framed box) used on arm cards and
// the frozen-bug button.
function OpenEditorIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M15 3h6v6" />
      <path d="M10 14 21 3" />
      <path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5" />
    </svg>
  )
}

// Outcome palette — shared by the per-iteration blocks and the aggregate.
const HEALED = 'rgb(52,211,153)'
const FAILED = 'rgb(251,113,133)'
const RUNNING = 'rgb(251,191,36)'

type IterState = 'healed' | 'failed' | 'running' | 'pending'

/**
 * One iteration's outcome as a self-describing block. Each iteration is its own
 * cell — number on top, an outcome dot, then that iteration's heal-cycles and
 * wall-clock — so "13s on which iteration?" is never ambiguous. Colour alone
 * carries the state at a glance; the full breakdown lives in the tooltip.
 */
function IterationBlock({ iter, state, cycles, seconds, delayMs }: {
  iter: number; state: IterState; cycles?: number; seconds?: number; delayMs: number
}) {
  const color = state === 'healed' ? HEALED : state === 'failed' ? FAILED : state === 'running' ? RUNNING : 'var(--text-muted)'
  const tint = state === 'pending' ? 'transparent' : `color-mix(in srgb, ${color} 12%, transparent)`
  const glyph = state === 'healed' ? '✓' : state === 'failed' ? '✗' : state === 'running' ? '' : '·'
  const tip = `Iteration ${iter} · ${
    state === 'healed' ? `healed in ${cycles} heal ${cycles === 1 ? 'cycle' : 'cycles'}, ${seconds}s`
      : state === 'failed' ? `failed after ${cycles} heal ${cycles === 1 ? 'cycle' : 'cycles'}, ${seconds}s`
        : state === 'running' ? 'in progress…' : 'not started yet'}`
  return (
    <div
      title={tip}
      style={{
        flex: '1 1 0', minWidth: 48, borderRadius: 'var(--radius-md)',
        border: `1px solid ${state === 'pending' ? 'var(--border-default)' : `color-mix(in srgb, ${color} 42%, transparent)`}`,
        borderStyle: state === 'pending' ? 'dashed' : 'solid',
        background: tint, padding: '6px 4px 5px', textAlign: 'center',
        animation: 'fm-fade-up 200ms ease-out both', animationDelay: `${delayMs}ms`,
      }}
    >
      <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: '.5px', color: 'var(--text-muted)', textTransform: 'uppercase' }}>iter {iter}</div>
      <div style={{ height: 17, display: 'flex', alignItems: 'center', justifyContent: 'center', marginTop: 1 }}>
        {state === 'running'
          ? <span className="canary-pulse" style={{ width: 7, height: 7, borderRadius: 9999, background: RUNNING, display: 'inline-block' }} />
          : <span style={{ fontSize: 13, lineHeight: 1, fontWeight: 700, color }}>{glyph}</span>}
      </div>
      <div style={{ fontSize: 11, fontFamily: 'var(--font-mono)', fontWeight: 600, color: state === 'pending' ? 'var(--text-muted)' : 'var(--text-primary)', marginTop: 2 }}>
        {state === 'healed' || state === 'failed' ? `${seconds}s` : state === 'running' ? '···' : '—'}
      </div>
      <div style={{ fontSize: 9.5, color: 'var(--text-muted)', marginTop: 1, minHeight: 12 }}>
        {state === 'healed' || state === 'failed' ? `${cycles} cyc` : ''}
      </div>
    </div>
  )
}

function ArmCard({ m, arm, focused, onClick }: { m: BenchmarkManifest; arm: BenchmarkArm; focused: boolean; onClick: () => void }) {
  const isHarness = arm === 'A'
  const accent = isHarness ? 'var(--boot)' : 'var(--accent)'
  const results = m.results.filter((r) => r.arm === arm)
  const byIter = new Map(results.map((r) => [r.iteration, r]))
  const healedCount = results.filter((r) => r.healed).length
  const done = m.status === 'done' || m.status === 'aborted' || m.status === 'error'

  // Build one block per planned iteration. Iterations are 1-indexed; the first
  // iteration still missing a result while the benchmark is live is the one
  // in flight (the arm barrier guarantees earlier ones are already recorded).
  let runningTaken = false
  const blocks = Array.from({ length: m.iterations }, (_, i): { iter: number; state: IterState; cycles?: number; seconds?: number } => {
    const iter = i + 1
    const r = byIter.get(iter)
    if (r) return { iter, state: r.healed ? 'healed' : 'failed', cycles: r.healCycles, seconds: Math.round(r.wallClockMs / 1000) }
    if (m.status === 'running' && !runningTaken) { runningTaken = true; return { iter, state: 'running' } }
    return { iter, state: 'pending' }
  })

  const aggColor = healedCount > 0 && healedCount === m.iterations ? HEALED
    : results.length > 0 ? (done && healedCount === 0 ? FAILED : RUNNING)
      : 'var(--text-muted)'

  // The arm worktree (heal-edited) exists only while the benchmark runs — it's
  // removed when the run finishes. So the live "open in editor" icon shows only
  // when the arm has a recorded worktree path and the benchmark is still going.
  const armLive = m.status === 'running' && Boolean(m.arms.find((a) => a.arm === arm)?.worktreePath)

  return (
    <div onClick={onClick} style={{
      border: `1px solid ${focused ? accent : 'var(--border-default)'}`,
      boxShadow: focused ? `0 0 0 1px ${accent}` : 'none',
      borderRadius: 'var(--radius-lg)', padding: '14px 16px', cursor: 'pointer', background: 'var(--bg-surface)',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', fontWeight: 600, fontSize: 13.5 }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
          <span style={{ color: isHarness ? 'var(--boot)' : 'var(--text-primary)' }}>{isHarness ? '🐤 Harness arm' : '⚙ Baseline arm'}</span>
          {armLive && (
            <button
              type="button"
              title="Open this arm's worktree in your editor — watch it heal live (only while the benchmark runs)"
              onClick={(e) => { e.stopPropagation(); void openWorktreeAction(m.benchmarkId, arm) }}
              style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 22, height: 22, padding: 0, borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-default)', background: 'var(--bg-input)', color: 'var(--text-secondary)', cursor: 'pointer' }}
            >
              <OpenEditorIcon />
            </button>
          )}
        </span>
        {results.length > 0 || done ? (
          <span style={{ fontSize: 11.5, fontWeight: 700, color: aggColor }}>
            {healedCount}<span style={{ color: 'var(--text-muted)', fontWeight: 600 }}>/{m.iterations}</span> healed
          </span>
        ) : (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11.5, fontWeight: 600, color: 'var(--text-muted)' }}>
            {m.status === 'running' && <span className="canary-pulse" style={{ width: 6, height: 6, borderRadius: 9999, background: RUNNING }} />}
            {m.status === 'running' ? 'running…' : 'queued'}
          </span>
        )}
      </div>
      {/* auto-fit grid: blocks fill the card for 2–3 iterations and wrap onto
          more rows for 5+, evenly sized, without stretching a lone orphan on
          the last row (column count is fixed by the first row). */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(52px, 1fr))', gap: 6, marginTop: 12 }}>
        {blocks.map((b, i) => (
          <IterationBlock key={b.iter} iter={b.iter} state={b.state} cycles={b.cycles} seconds={b.seconds} delayMs={i * 45} />
        ))}
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
  const verdict = benchmarkVerdict(rep)
  const toneColor = verdict.tone === 'win' ? HEALED : verdict.tone === 'loss' ? FAILED : 'var(--text-primary)'
  const heroBorder = verdict.tone === 'even'
    ? 'var(--border-default)'
    : `color-mix(in srgb, ${toneColor} 45%, var(--border-default))`
  const heroBg = verdict.tone === 'even'
    ? 'color-mix(in srgb, var(--text-muted) 5%, transparent)'
    : `color-mix(in srgb, ${toneColor} 8%, transparent)`
  const bothTokens = rep.harness.totalTokens != null && rep.baseline.totalTokens != null
  return (
    <div style={{ maxWidth: 880, margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 10 }}>
        <button
          className="cl-button"
          style={{ padding: '6px 12px' }}
          onClick={() => downloadText(`${m.benchmarkId}.md`, benchmarkReportMarkdown(m, verdict.headline), 'text/markdown')}
        >
          ⬇ Export report
        </button>
      </div>
      <div style={{ border: `1px solid ${heroBorder}`, background: heroBg, borderRadius: 'var(--radius-xl)', padding: '20px 22px', marginBottom: 16 }}>
        <div style={{ fontSize: 25, fontWeight: 700, color: toneColor, lineHeight: 1.05, letterSpacing: '-.01em' }}>{verdict.headline}</div>
        <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginTop: 7, lineHeight: 1.5, maxWidth: 620 }}>{verdict.detail}</div>

        {/* Head-to-head bars: each metric on a shared scale so the gap that
            actually decides the winner is visible, not buried in fine print. */}
        <div style={{ marginTop: 18, display: 'grid', gridTemplateColumns: '96px 1fr 1fr', alignItems: 'center', gap: '0 16px' }}>
          <div />
          <ArmHeading emoji="🐤" label="Harness" color="var(--boot)" />
          <ArmHeading emoji="⚙" label="Baseline" color="rgb(251,191,36)" />
        </div>
        <div style={{ marginTop: 2 }}>
          <CompareRow label="Healed" hValue={rep.harness.iterationsHealed} bValue={rep.baseline.iterationsHealed}
            hText={`${rep.harness.iterationsHealed}/${rep.harness.iterationsTotal}`} bText={`${rep.baseline.iterationsHealed}/${rep.baseline.iterationsTotal}`} betterIsLower={false} />
          <CompareRow label="Repair time" hValue={rep.harness.totalWallClockMs} bValue={rep.baseline.totalWallClockMs}
            hText={fmtSecs(rep.harness.totalWallClockMs)} bText={fmtSecs(rep.baseline.totalWallClockMs)} betterIsLower />
          <CompareRow label="Avg cycles" hValue={rep.harness.avgHealCycles} bValue={rep.baseline.avgHealCycles}
            hText={rep.harness.avgHealCycles.toFixed(1)} bText={rep.baseline.avgHealCycles.toFixed(1)} betterIsLower />
          {bothTokens && (
            <CompareRow label="Tokens" hValue={rep.harness.totalTokens!} bValue={rep.baseline.totalTokens!}
              hText={fmtTokens(rep.harness.totalTokens!)} bText={fmtTokens(rep.baseline.totalTokens!)} betterIsLower />
          )}
        </div>

        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 16, paddingTop: 12, borderTop: '1px solid var(--border-default)' }}>
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

function ArmHeading({ emoji, label, color }: { emoji: string; label: string; color: string }) {
  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11.5, fontWeight: 600 }}>
      <span>{emoji}</span><span style={{ color }}>{label}</span>
    </div>
  )
}

// One metric, harness vs baseline, on a shared scale (so bar lengths are
// directly comparable across the row). The better value is flagged ✓ — for
// time/cycles/tokens lower wins, for healed higher wins.
function CompareRow({ label, hValue, bValue, hText, bText, betterIsLower }: {
  label: string; hValue: number; bValue: number; hText: string; bText: string; betterIsLower: boolean
}) {
  const max = Math.max(hValue, bValue, 0.0001)
  const hPct = Math.max(4, (hValue / max) * 100)
  const bPct = Math.max(4, (bValue / max) * 100)
  const tie = hValue === bValue
  const hBetter = !tie && (betterIsLower ? hValue < bValue : hValue > bValue)
  const bBetter = !tie && !hBetter
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '96px 1fr 1fr', alignItems: 'center', gap: '0 16px', padding: '6px 0' }}>
      <div style={{ fontSize: 10.5, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '.4px', fontWeight: 600 }}>{label}</div>
      <Bar pct={hPct} color="var(--boot)" text={hText} better={hBetter} />
      <Bar pct={bPct} color="rgb(251,191,36)" text={bText} better={bBetter} />
    </div>
  )
}

function Bar({ pct, color, text, better }: { pct: number; color: string; text: string; better: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <div style={{ flex: 1, minWidth: 0, height: 7, borderRadius: 9999, background: 'color-mix(in srgb, var(--text-muted) 16%, transparent)', overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', borderRadius: 9999, background: color, transition: 'width 320ms cubic-bezier(.2,.7,.3,1)' }} />
      </div>
      <span style={{ fontSize: 12, fontFamily: 'var(--font-mono)', fontWeight: better ? 700 : 500, color: better ? 'var(--text-primary)' : 'var(--text-muted)', whiteSpace: 'nowrap', flex: 'none' }}>
        {text}{better && <span style={{ color: HEALED, marginLeft: 4 }}>✓</span>}
      </span>
    </div>
  )
}

// The honest verdict: lead with reliability when the arms differ on it, else
// fall back to the speed gap (the real story on a reliability tie). Tone drives
// the hero colour so a tie/loss isn't dressed up in win-green.
function benchmarkVerdict(rep: BenchmarkReport): { headline: string; detail: string; tone: 'win' | 'even' | 'loss' } {
  const h = rep.harness
  const b = rep.baseline
  const speedMult = h.totalWallClockMs > 0 && b.totalWallClockMs > 0 ? b.totalWallClockMs / h.totalWallClockMs : null
  if (b.iterationsHealed === 0 && h.iterationsHealed > 0) {
    return { headline: 'Healed where the baseline couldn’t', detail: `Harness fixed ${h.iterationsHealed}/${h.iterationsTotal}; the baseline never reached green.`, tone: 'win' }
  }
  if (h.iterationsHealed > b.iterationsHealed && rep.reliabilityMultiple != null) {
    return { headline: `${rep.reliabilityMultiple.toFixed(1)}× more reliable repair`, detail: `Harness healed ${h.iterationsHealed}/${h.iterationsTotal} vs ${b.iterationsHealed}/${b.iterationsTotal} for the baseline.`, tone: 'win' }
  }
  if (h.iterationsHealed < b.iterationsHealed) {
    return { headline: 'Baseline healed more often', detail: `Harness ${h.iterationsHealed}/${h.iterationsTotal} vs baseline ${b.iterationsHealed}/${b.iterationsTotal} — context didn’t help here.`, tone: 'loss' }
  }
  // Reliability tied — speed is the story.
  if (speedMult != null && speedMult >= 1.15) {
    return { headline: `${speedMult.toFixed(1)}× faster repair`, detail: `Same reliability (${h.iterationsHealed}/${h.iterationsTotal} healed) — harness reached green in ${fmtSecs(h.totalWallClockMs)} vs ${fmtSecs(b.totalWallClockMs)}.`, tone: 'win' }
  }
  if (speedMult != null && speedMult <= 1 / 1.15) {
    return { headline: 'Matched on reliability', detail: `Both healed ${h.iterationsHealed}/${h.iterationsTotal}; the baseline was a touch faster (${fmtSecs(b.totalWallClockMs)} vs ${fmtSecs(h.totalWallClockMs)}).`, tone: 'even' }
  }
  return { headline: 'Matched the baseline', detail: `Both arms healed ${h.iterationsHealed}/${h.iterationsTotal} in comparable time.`, tone: 'even' }
}

function fmtSecs(ms: number): string {
  return `${Math.round(ms / 1000)}s`
}

function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : `${n}`
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
