import { useElapsed } from '@/shared/state/use-elapsed'
import { formatBytes } from '@/shared/lib/format'
import { isActiveBenchmarkStatus, isTerminalBenchmarkStatus } from '@shared/benchmark-index'
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import * as benchmarkApi from '@/shared/api/benchmark'
import type {
  BenchmarkArm,
  BenchmarkManifest,
  BenchmarkReport,
  SabotageSkillSummary,
} from '../api/benchmark-types'
import type { SabotageLevel } from '@shared/benchmark-index'
import { useBenchmarkDetail, useBenchmarks } from '../state/BenchmarkContext'
import { RunDetailColumn } from '@/features/runs/components/RunDetailColumn'
import { AgentSessionView } from '@/shared/ui/AgentSessionView'
import { cell } from './BenchmarkArmMatrix'
import { Centered } from './BenchmarkConfigScreen'
import { BenchmarkHeader, isTerminal, lifecycleStage } from './BenchmarkHeader'
import { ReportView } from './BenchmarkReport'
import { displayError } from '@/shared/api/error-message'
import { ConfirmModal } from '@/shared/ui/Overlays'
import { CheckIcon, TrashIcon } from '@/shared/ui/Icons'

// ─── Detail (setup / race / report) ─────────────────────────────────────────

export function BenchmarkDetail({ id, onClose, onNew }: { id: string; onClose: () => void; onNew: () => void }) {
  const detail = useBenchmarkDetail(id)
  const m = detail.manifest
  const { abortBenchmark } = useBenchmarks()
  const [tab, setTab] = useState<'race' | 'report'>('race')
  const [armFocus, setArmFocus] = useState<BenchmarkArm>('A')
  // In-app confirmations and notices; these were `window.confirm`/`alert`/
  // `prompt` — OS sheets the app's tokens and theme never reach.
  const [confirmStop, setConfirmStop] = useState(false)
  const [pendingClear, setPendingClear] = useState<string | null>(null)
  const [clearing, setClearing] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  // When the run reaches a terminal state, land on the Report (the payoff) —
  // once, on the transition, so a manual switch back to Race is respected.
  const prevStatus = useRef<string | undefined>(undefined)
  useEffect(() => {
    const s = m?.status
    if (s && isTerminal(s) && !isTerminal(prevStatus.current)) setTab('report')
    prevStatus.current = s
  }, [m?.status])

  if (!m) {
    return (<><BenchmarkHeader stage={1} title="Benchmark" onClose={onClose} /><Centered>
      {detail.loading ? 'Loading…' : <div role="status">
        <p>{detail.missing ? 'This benchmark is no longer available.' : detail.error ?? 'Could not load benchmark'}</p>
        <button type="button" className="cl-button" onClick={detail.retry}>Retry</button>
      </div>}
    </Centered></>)
  }

  const sabotaging = m.status === 'sabotaging' || m.status === 'ready'
  const terminal = isTerminalBenchmarkStatus(m.status)
  // Worktrees are kept after a run so these stay usable; clearing is the user's
  // call (Report tab). Once cleared, the open actions are gone — show a receipt.
  const showFrozen = !!m.sabotageSha && !m.worktreesCleared && !sabotaging && m.status !== 'error'
  const showClear = terminal && m.status !== 'error' && tab === 'report' && !m.worktreesCleared && !!m.sabotageSha
  const showReceipt = !!m.worktreesCleared && tab === 'report'
  const showTopRow = showFrozen || showClear || showReceipt
  const openWorktree = (target: 'frozen' | BenchmarkArm): void => {
    setNotice(null)
    void openWorktreeAction(m.benchmarkId, target).then(setNotice)
  }
  const requestClear = (): void => {
    setNotice(null)
    previewWorktreeClear(m.benchmarkId)
      .then(setPendingClear)
      .catch((e: unknown) => setNotice(displayError(e)))
  }
  const confirmClear = (): void => {
    setClearing(true)
    benchmarkApi.clearBenchmarkWorktrees(m.benchmarkId, true)
      .catch((e: unknown) => setNotice(displayError(e)))
      .finally(() => { setClearing(false); setPendingClear(null) })
  }

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
            ? () => setConfirmStop(true)
            : undefined
        }
        onNew={onNew}
        onClose={onClose}
      />
      <div style={{ flex: 1, overflow: 'auto', padding: 18 }}>
        {notice && (
          <div role="alert" data-testid="benchmark-notice" style={{ fontSize: 12, color: 'var(--danger)', marginBottom: 12, wordBreak: 'break-all' }}>{notice}</div>
        )}
        {showTopRow && (
          <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 8, marginBottom: 12 }}>
            {showReceipt && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 11.5, color: 'var(--text-muted)' }}>
                <CheckIcon /> Worktrees cleared
                {m.worktreesClearedBytes !== undefined ? ` · reclaimed ${formatBytes(m.worktreesClearedBytes)}` : ''}
              </span>
            )}
            {showFrozen && (
              <button
                type="button"
                className="cl-button"
                title="Open a pristine checkout of the frozen (destroyed) code in your editor"
                onClick={() => openWorktree('frozen')}
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
                onClick={requestClear}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '6px 12px', fontSize: 12 }}
              >
                <TrashIcon size={13} /> Clear worktrees
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
          <RaceView m={m} armFocus={armFocus} setArmFocus={setArmFocus} onOpenWorktree={openWorktree} />
        )}
      </div>
      <ConfirmModal
        open={confirmStop}
        title="Stop benchmark"
        variant="danger"
        confirmLabel="Stop"
        message="Both arms will be aborted."
        onCancel={() => setConfirmStop(false)}
        onConfirm={() => { setConfirmStop(false); void abortBenchmark(m.benchmarkId) }}
      />
      <ConfirmModal
        open={pendingClear !== null}
        title="Clear worktrees"
        variant="danger"
        confirmLabel="Clear"
        busy={clearing}
        message={<>“Open frozen bug” and the arm checkouts will no longer be available. Reclaims <strong>{pendingClear}</strong>.</>}
        onCancel={() => setPendingClear(null)}
        onConfirm={confirmClear}
      />
    </>
  )
}

export function SetupView({ m }: { m: BenchmarkManifest }) {
  const elapsed = useElapsed(m.startedAt)

  return (
    <div style={{ color: 'var(--text-secondary)', fontSize: 13, maxWidth: 980, display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <span className="animate-pulse" style={{ width: 9, height: 9, borderRadius: 9999, background: 'var(--running)', flex: 'none' }} />
        <span>
          Sabotaging <span style={{ fontFamily: 'var(--font-mono)' }}>{m.feature}</span> with the <b>{m.level}</b> skill…{' '}
          {elapsed && <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>{elapsed}</span>}
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

export function RaceView({ m, armFocus, setArmFocus, onOpenWorktree }: {
  m: BenchmarkManifest
  armFocus: BenchmarkArm
  setArmFocus: (a: BenchmarkArm) => void
  onOpenWorktree: (arm: BenchmarkArm) => void
}) {
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
          <ArmCard key={arm} m={m} arm={arm} focused={armFocus === arm} onClick={() => setArmFocus(arm)} onOpenWorktree={() => onOpenWorktree(arm)} />
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
  const waiting = isActiveBenchmarkStatus(status)
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

// Open a benchmark worktree in the user's editor. Resolves to the notice to
// show, or null when the editor opened: if it couldn't be launched, the path is
// surfaced so it can be opened by hand.
export async function openWorktreeAction(id: string, target: 'frozen' | BenchmarkArm): Promise<string | null> {
  try {
    const r = await benchmarkApi.openBenchmarkWorktree(id, target)
    return r.opened ? null : `Could not launch your editor. The worktree is at ${r.path}`
  } catch (e) {
    return displayError(e)
  }
}

// The first phase of reclaiming a finished benchmark's worktrees: a dry run
// that resolves to the disk it would free (named in the confirm), or null when
// they are already gone. The confirmed removal's manifest update flows back
// over the benchmark WS, so the buttons hide on their own.
export async function previewWorktreeClear(id: string): Promise<string | null> {
  const preview = await benchmarkApi.clearBenchmarkWorktrees(id, false)
  return preview.alreadyCleared ? null : formatBytes(preview.freedBytes)
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

export function ArmCard({ m, arm, focused, onClick, onOpenWorktree }: {
  m: BenchmarkManifest
  arm: BenchmarkArm
  focused: boolean
  onClick: () => void
  onOpenWorktree: () => void
}) {
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
              onClick={(e) => { e.stopPropagation(); onOpenWorktree() }}
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
