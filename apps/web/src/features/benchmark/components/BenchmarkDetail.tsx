import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import * as api from '@/shared/api/client'
import type { BenchmarkArm, BenchmarkManifest, BenchmarkReport, SabotageLevel, SabotageSkillSummary } from '../api/benchmark-types'
import { useBenchmark, useBenchmarks } from '../state/BenchmarkContext'
import { RunDetailColumn } from '@/features/runs'
import { AgentSessionView } from '@/shared/ui/AgentSessionView'
import { cell } from './BenchmarkArmMatrix'
import { Centered } from './BenchmarkConfigScreen'
import { BenchmarkHeader, isTerminal, lifecycleStage } from './BenchmarkHeader'
import { ReportView } from './BenchmarkReport'

// ─── Detail (setup / race / report) ─────────────────────────────────────────

export function BenchmarkDetail({ id, onClose, onNew }: { id: string; onClose: () => void; onNew: () => void }) {
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
  const terminal = m.status === 'done' || m.status === 'aborted' || m.status === 'error' || m.status === 'invalid'
  // Worktrees are kept after a run so these stay usable; clearing is the user's
  // call (Report tab). Once cleared, the open actions are gone — show a receipt.
  const showFrozen = !!m.sabotageSha && !m.worktreesCleared && !sabotaging && m.status !== 'error'
  const showClear = terminal && m.status !== 'error' && tab === 'report' && !m.worktreesCleared && !!m.sabotageSha
  const showReceipt = !!m.worktreesCleared && tab === 'report'
  const showTopRow = showFrozen || showClear || showReceipt

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
        {showTopRow && (
          <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 8, marginBottom: 12 }}>
            {showReceipt && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 11.5, color: 'var(--text-muted)' }}>
                <CheckIcon /> Worktrees cleared
                {m.worktreesClearedBytes ? ` · reclaimed ${formatBytes(m.worktreesClearedBytes)}` : ''}
              </span>
            )}
            {showFrozen && (
              <button
                type="button"
                className="cl-button"
                title="Open a pristine checkout of the frozen (destroyed) code in your editor"
                onClick={() => void openWorktreeAction(m.benchmarkId, 'frozen')}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '6px 12px', fontSize: 12 }}
              >
                <OpenEditorIcon /> Open frozen bug
              </button>
            )}
            {showClear && (
              <button
                type="button"
                className="cl-button"
                title="Remove this benchmark's worktrees (staging + both arms) to reclaim disk — afterward the frozen bug and arm checkouts are no longer openable"
                onClick={() => void clearWorktreesAction(m.benchmarkId)}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '6px 12px', fontSize: 12 }}
              >
                <TrashIcon /> Clear worktrees
              </button>
            )}
          </div>
        )}
        {sabotaging ? (
          <SetupView m={m} />
        ) : m.status === 'error' ? (
          <div style={{ color: 'var(--danger)', fontSize: 13 }}>Benchmark error: {m.error}</div>
        ) : m.status === 'invalid' ? (
          <div style={{ maxWidth: 640, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--warning)', fontSize: 13, fontWeight: 600 }}>
              <span style={{ width: 9, height: 9, borderRadius: 9999, background: 'var(--warning)', flex: 'none' }} />
              Sabotage didn’t land
            </div>
            <div style={{ color: 'var(--text-secondary)', fontSize: 13, lineHeight: 1.6 }}>
              {m.error || 'The frozen sabotage broke no test, so there was nothing to race. Re-run the benchmark to try a different break.'}
            </div>
            {onNew && (
              <div>
                <button type="button" className="cl-button" onClick={onNew} style={{ padding: '6px 12px', fontSize: 12 }}>
                  New benchmark
                </button>
              </div>
            )}
          </div>
        ) : tab === 'report' ? (
          <ReportView m={m} />
        ) : (
          <RaceView m={m} armFocus={armFocus} setArmFocus={setArmFocus} />
        )}
      </div>
    </>
  )
}

export function SetupView({ m }: { m: BenchmarkManifest }) {
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
        <span className="animate-pulse" style={{ width: 9, height: 9, borderRadius: 9999, background: 'var(--running)', flex: 'none' }} />
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
        <AgentSessionView source={{ kind: 'benchmark', benchmarkId: m.benchmarkId, live: true }} />
      </div>
    </div>
  )
}

export function RaceView({ m, armFocus, setArmFocus }: { m: BenchmarkManifest; armFocus: BenchmarkArm; setArmFocus: (a: BenchmarkArm) => void }) {
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
export function ArmEmptyState({ arm, accent, status }: { arm: BenchmarkArm; accent: string; status: BenchmarkManifest['status'] }) {
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
export async function openWorktreeAction(id: string, target: 'frozen' | 'A' | 'B'): Promise<void> {
  try {
    const r = await api.openBenchmarkWorktree(id, target)
    if (!r.opened) {
      window.prompt('Could not launch your editor automatically — copy this path:', r.path)
    }
  } catch (e) {
    window.alert(e instanceof Error ? e.message : String(e))
  }
}

// Reclaim a finished benchmark's worktrees. Two-phase: a dry run fetches the
// disk it would free (named in the confirm), then the confirmed call removes
// them. The manifest update flows back over the benchmark WS, so the buttons
// hide on their own — nothing to refresh here.
export async function clearWorktreesAction(id: string): Promise<void> {
  try {
    const preview = await api.clearBenchmarkWorktrees(id, false)
    if (preview.alreadyCleared) return
    const size = formatBytes(preview.freedBytes)
    const ok = window.confirm(
      `Clear all worktrees for this benchmark? "Open frozen bug" and the arm checkouts will no longer be available. Reclaims ${size}.`,
    )
    if (!ok) return
    await api.clearBenchmarkWorktrees(id, true)
  } catch (e) {
    window.alert(e instanceof Error ? e.message : String(e))
  }
}

// Bytes → a short human size for the confirm + the post-clear receipt.
export function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return 'no disk'
  const mb = bytes / 1_000_000
  if (mb < 1) return '<1 MB'
  if (mb < 1000) return `~${Math.round(mb)} MB`
  return `~${(mb / 1000).toFixed(1)} GB`
}

// A small trash affordance for the "Clear worktrees" button.
export function TrashIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 6h18" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
    </svg>
  )
}

// A check used by the post-clear receipt line.
export function CheckIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  )
}

// Small "open in editor" affordance (↗ in a framed box) used on arm cards and
// the frozen-bug button.
export function OpenEditorIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M15 3h6v6" />
      <path d="M10 14 21 3" />
      <path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5" />
    </svg>
  )
}

// Outcome palette — shared by the per-iteration blocks and the aggregate.
export const HEALED = 'var(--success)'

export const FAILED = 'var(--danger)'

export const RUNNING = 'var(--warning)'

export type IterState = 'healed' | 'failed' | 'running' | 'pending'

/**
 * One iteration's outcome as a self-describing block. Each iteration is its own
 * cell — number on top, an outcome dot, then that iteration's heal-cycles and
 * wall-clock — so "13s on which iteration?" is never ambiguous. Colour alone
 * carries the state at a glance; the full breakdown lives in the tooltip.
 */
export function IterationBlock({ iter, state, cycles, seconds, delayMs }: {
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

export function ArmCard({ m, arm, focused, onClick }: { m: BenchmarkManifest; arm: BenchmarkArm; focused: boolean; onClick: () => void }) {
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

  // The arm worktree (heal-edited) is kept after the run for inspection, so the
  // "open in editor" icon stays available once the arm has a recorded worktree
  // path — during the race AND afterward — until the user clears the worktrees.
  const canOpenArm = !m.worktreesCleared && Boolean(m.arms.find((a) => a.arm === arm)?.worktreePath)

  return (
    <div onClick={onClick} style={{
      border: `1px solid ${focused ? accent : 'var(--border-default)'}`,
      boxShadow: focused ? `0 0 0 1px ${accent}` : 'none',
      borderRadius: 'var(--radius-lg)', padding: '14px 16px', cursor: 'pointer', background: 'var(--bg-surface)',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', fontWeight: 600, fontSize: 13.5 }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
          <span style={{ color: isHarness ? 'var(--boot)' : 'var(--text-primary)' }}>{isHarness ? '🐤 Harness arm' : '⚙ Baseline arm'}</span>
          {canOpenArm && (
            <button
              type="button"
              title={m.status === 'running'
                ? "Open this arm's worktree in your editor — watch it heal live"
                : "Open this arm's worktree in your editor — inspect what it changed"}
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
