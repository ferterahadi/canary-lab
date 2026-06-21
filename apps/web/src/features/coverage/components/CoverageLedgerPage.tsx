import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as api from '../../../shared/api/client'
import type {
  CoverageJobKind,
  CoverageJobManifest,
  CoverageLedger,
  CoverageStatus,
  GapType,
  RequirementCoverage,
  TestCoverage,
} from '../../../shared/api/types'
import { CoverageDocsRail } from './CoverageDocsRail'
import { CoverageGeneratingPane } from './CoverageGeneratingPane'

interface Props {
  feature: string
  onClose: () => void
}

// Each gap class gets a stable label + colour. `unverified` is the dangerous one
// (a test exists but no passing run backs it) so it borrows the danger hue;
// `shallow-verified` is amber (passes, but only a weak assertion tier).
const GAP_META: Record<GapType, { label: string; color: string }> = {
  verified: { label: 'Verified', color: 'rgb(52, 211, 153)' },
  'shallow-verified': { label: 'Shallow', color: 'rgb(251, 191, 36)' },
  'path-incomplete': { label: 'Path-incomplete', color: 'rgb(56, 189, 248)' },
  unverified: { label: 'Unverified', color: 'rgb(251, 113, 133)' },
  untested: { label: 'Untested', color: 'var(--text-muted)' },
}

const BADGE_ORDER: GapType[] = ['untested', 'unverified', 'path-incomplete', 'shallow-verified']

// Requirements list is ordered worst-first (uncovered → partial → covered) so the
// gaps that need work sit at the top — the whole point of the ledger.
const STATUS_RANK: Record<CoverageStatus, number> = { uncovered: 0, partial: 1, covered: 2 }

// Golden-angle hue rotation gives each test a distinct, stable colour regardless
// of how many there are. Mid lightness reads on both light and dark themes.
function testColor(index: number): string {
  return `hsl(${Math.round((index * 137.508) % 360)}, 65%, 55%)`
}

interface Hovered {
  kind: 'test' | 'req'
  key: string
}

export function CoverageLedgerPage({ feature, onClose }: Props) {
  const [ledger, setLedger] = useState<CoverageLedger | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [hovered, setHovered] = useState<Hovered | null>(null)
  const [gapFilter, setGapFilter] = useState<GapType | null>(null)
  // R22: one unified view (no tabs). Docs is a collapsible left rail; its
  // open/closed state persists across refresh (R12).
  const [railOpen, setRailOpen] = useState<boolean>(() => readRailPref())

  // Async generation (R4 jobs). Summary + Coverage are ONE exercise (R14): a
  // summary job auto-chains a coverage job, and we follow that chain so the
  // single `job` here represents whichever phase is live. ONE owner of the job
  // lifecycle for the whole dialog (R20) — rail + columns + takeover all read it.
  // While a job runs the view is a full-screen Generating takeover (R13).
  const [job, setJob] = useState<CoverageJobManifest | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  // Bumped when a generation job completes so the Docs rail re-lists itself and
  // the generated _prd-summary.md pill shows up live (items 1+2). Driven off the
  // reliable pollJob completion, not a best-effort broadcast (cl_live-state-sync).
  const [docsReloadKey, setDocsReloadKey] = useState(0)
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const toggleRail = useCallback(() => setRailOpen((v) => { writeRailPref(!v); return !v }), [])

  const refresh = useCallback(() => {
    setLoading(true)
    api.getFeatureCoverage(feature)
      .then((data) => { setLedger(data); setError(null) })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false))
  }, [feature])

  useEffect(() => { refresh() }, [refresh])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => () => { if (pollRef.current) clearTimeout(pollRef.current) }, [])

  const pollJob = useCallback((jobId: string) => {
    const tick = () => {
      api.getCoverageJob(jobId)
        .then((m) => {
          setJob(m)
          if (m.status === 'running') {
            pollRef.current = setTimeout(tick, 800)
          } else if (m.status === 'done' && m.chainedJobId) {
            // Summary done → the generated _prd-summary.md now exists; re-list the
            // rail so its pill appears immediately (items 1+2), then follow the
            // auto-chained coverage job (R14) — Generating screen stays up.
            refresh()
            setDocsReloadKey((k) => k + 1)
            pollJob(m.chainedJobId)
          } else {
            if (m.status === 'failed') setActionError(m.error ?? 'generation failed')
            setJob(null)
            refresh()
            setDocsReloadKey((k) => k + 1)
          }
        })
        .catch((e: unknown) => { setActionError(e instanceof Error ? e.message : String(e)); setJob(null) })
    }
    tick()
  }, [refresh])

  const startJob = useCallback((kind: CoverageJobKind) => {
    setActionError(null)
    api.startCoverageJob(feature, kind)
      .then((m) => { setJob(m); pollJob(m.jobId) })
      .catch((e: unknown) => {
        // A 409 means a job is already running (e.g. started from another tab/
        // session) — ATTACH to it instead of surfacing a raw error (R20).
        if (e instanceof api.ApiError && e.status === 409) {
          const existing = (e.body as { existingJobId?: string } | null)?.existingJobId
          if (existing) { pollJob(existing); return }
        }
        setActionError(e instanceof Error ? e.message : String(e))
      })
  }, [feature, pollJob])

  // R18: a generation job is durable server-side, so on mount (incl. after a
  // refresh) re-attach to the newest running job and resume the Generating
  // screen + chain-following. The in-memory flag alone lost this on reload.
  useEffect(() => {
    let cancelled = false
    api.listCoverageJobs(feature)
      .then((jobs) => {
        if (cancelled) return
        const running = jobs
          .filter((j) => j.status === 'running')
          .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))[0]
        if (running) {
          // Show the Generating screen immediately from the index entry (no flash
          // of the ledger), then the poller refines it with the live log + chain.
          setJob({ ...running, log: '' })
          pollJob(running.jobId)
        }
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [feature, pollJob])

  // Stable colour per test name (by position in the ledger's test list).
  const colorByTest = useMemo(() => {
    const map = new Map<string, string>()
    ledger?.tests.forEach((t, i) => map.set(t.name, testColor(i)))
    return map
  }, [ledger])

  // The two-way highlight relation: a hovered test lights its requirements; a
  // hovered requirement lights its tests.
  const { activeReqIds, activeTestNames } = useMemo(() => {
    const reqIds = new Set<string>()
    const testNames = new Set<string>()
    if (hovered && ledger) {
      if (hovered.kind === 'test') {
        testNames.add(hovered.key)
        const t = ledger.tests.find((x) => x.name === hovered.key)
        for (const id of t?.requirements ?? []) reqIds.add(id)
      } else {
        reqIds.add(hovered.key)
        for (const t of ledger.tests) {
          if (t.requirements.includes(hovered.key)) testNames.add(t.name)
        }
      }
    }
    return { activeReqIds: reqIds, activeTestNames: testNames }
  }, [hovered, ledger])

  const visibleReqs = useMemo(() => {
    if (!ledger) return []
    const filtered = gapFilter ? ledger.requirements.filter((r) => r.gapType === gapFilter) : ledger.requirements
    // Worst-first: uncovered → partial → covered, stable within a rank.
    return [...filtered].sort((a, b) => STATUS_RANK[statusOf(a)] - STATUS_RANK[statusOf(b)])
  }, [ledger, gapFilter])

  const orphanTests = useMemo(
    () => ledger?.tests.filter((t) => t.requirements.length === 0) ?? [],
    [ledger],
  )

  const generating = Boolean(job)

  const state = ledger?.state
  const summaryAbsent = state?.summary === 'absent'

  // Tests pane — shown in BOTH the final ledger and (R: 3-column generating) while
  // a job runs, since generation doesn't change the test SET, only its mapping.
  // While generating, the mapping (@req/@path chips) is exactly what's being
  // recomputed, so showing the stale chips reads as "already done" against the
  // middle pane's "Mapping coverage…". Instead the cards keep their grounded,
  // stable bits (name, verified dot, file) and the mapping row becomes a skeleton
  // — the pane is honestly in the loading state until the new ledger lands.
  const testsPaneEl = ledger ? (
    <div className="min-h-0 flex-1 overflow-auto p-4" style={{ scrollbarGutter: 'stable' }} data-testid="tests-pane">
      {ledger.tests.length === 0 && (
        <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>No tests found in this feature&apos;s specs.</div>
      )}
      {generating ? (
        <div data-testid="tests-remapping-note" style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 10, fontSize: 11, color: 'rgb(56, 189, 248)' }}>
          <span className="cl-pulse" aria-hidden="true" style={{ width: 6, height: 6, borderRadius: '50%', background: 'rgb(56, 189, 248)' }} />
          Remapping coverage for these tests…
        </div>
      ) : orphanTests.length > 0 ? (
        <div data-testid="orphan-tests-note" style={{ marginBottom: 10, fontSize: 11, color: 'rgb(251, 191, 36)' }}>
          {orphanTests.length} orphan test{orphanTests.length > 1 ? 's' : ''} (no requirement) — regenerate coverage to map them.
        </div>
      ) : null}
      {ledger.tests.map((t) => (
        <TestCard
          key={t.name}
          test={t}
          color={colorByTest.get(t.name)!}
          loading={generating}
          active={!generating && activeTestNames.has(t.name)}
          dimmed={!generating && Boolean(hovered) && !activeTestNames.has(t.name)}
          onHover={(on) => setHovered(on ? { kind: 'test', key: t.name } : null)}
        />
      ))}
    </div>
  ) : null

  return (
    <div className="clcov-root fixed inset-0 z-[60] flex flex-col" style={{ background: 'var(--bg-base)' }} data-testid="coverage-ledger">
      <style>{COVERAGE_CSS}</style>
      <header className="clcov-head" data-generating={generating ? 'true' : 'false'}>
        <div className="clcov-title">
          <span className="clcov-eyebrow">Verified Coverage</span>
          <span className="clcov-feature">{feature}</span>
        </div>
        {state && <HeadlinePill headline={state.headline} />}
        <button type="button" onClick={onClose} className="clcov-close ml-auto" aria-label="Close coverage">
          Close <span aria-hidden="true">✕</span>
        </button>
      </header>

      {loading && !ledger && <div className="p-6" style={{ color: 'var(--text-secondary)' }}>Loading coverage…</div>}
      {error && <div className="p-6" style={{ color: 'rgb(251, 113, 133)' }}>Failed to load coverage: {error}</div>}

      {/* Unified view (R22): Docs rail + main, always one screen. The rail is
          ALWAYS present (even while generating, with destructive actions disabled);
          only the main area changes by state — no tabs, nothing unmounts. */}
      {!error && ledger && (
        <div className="flex min-h-0 flex-1">
          <CoverageDocsRail
            feature={feature}
            open={railOpen}
            onToggle={toggleRail}
            generating={generating}
            summaryAbsent={summaryAbsent}
            summaryStale={state?.summary === 'stale'}
            coverageActionable={state?.summary === 'fresh'}
            drift={state?.summary === 'stale' ? state.drift : null}
            onGenerate={startJob}
            onDocsChanged={refresh}
            reloadKey={docsReloadKey}
          />
          <div className="flex min-h-0 flex-1 flex-col">
            {actionError && (
              <div data-testid="coverage-action-error" className="shrink-0 border-b px-5 py-2" style={{ borderColor: 'var(--border-default)', fontSize: 12, color: 'rgb(251, 113, 133)' }}>
                {actionError}
              </div>
            )}
            {job ? (
              /* Generating: the middle column shows the progress + agent activity;
                 Tests stays beside it (generation doesn't change the test set). */
              <div className="flex min-h-0 flex-1">
                <div className="min-h-0 flex-1 overflow-hidden border-r" style={{ borderColor: 'var(--border-default)' }}>
                  <CoverageGeneratingPane feature={feature} job={job} />
                </div>
                {testsPaneEl}
              </div>
            ) : summaryAbsent ? (
              <CoverageEmptyMain railOpen={railOpen} />
            ) : (
              <>
                <CoverageHeader ledger={ledger} gapFilter={gapFilter} onToggleGap={(g) => setGapFilter((cur) => (cur === g ? null : g))} />
                <div className="flex min-h-0 flex-1">
                  {/* PRD / requirements pane */}
                  <div className="min-h-0 flex-1 overflow-auto border-r p-4" style={{ borderColor: 'var(--border-default)', scrollbarGutter: 'stable' }} data-testid="prd-pane">
                    {visibleReqs.length === 0 && (
                      <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>
                        {ledger.requirements.length === 0 ? 'No PRD requirements yet — regenerate the summary.' : 'No requirements match this filter.'}
                      </div>
                    )}
                    {visibleReqs.map((rc) => (
                      <RequirementCard
                        key={rc.requirement.id}
                        rc={rc}
                        colors={(ledger.tests.filter((t) => t.requirements.includes(rc.requirement.id)).map((t) => colorByTest.get(t.name)!))}
                        active={activeReqIds.has(rc.requirement.id)}
                        dimmed={Boolean(hovered) && !activeReqIds.has(rc.requirement.id)}
                        onHover={(on) => setHovered(on ? { kind: 'req', key: rc.requirement.id } : null)}
                      />
                    ))}
                  </div>
                  {testsPaneEl}
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// Empty main (summary ABSENT) — the rail holds the docs + Generate CTA, so the
// main area just points there. Never a dead-end (cl_ui-design-philosophy).
function CoverageEmptyMain({ railOpen }: { railOpen: boolean }) {
  return (
    <div className="min-h-0 flex-1 overflow-auto" style={{ scrollbarGutter: 'stable' }} data-testid="coverage-empty-main">
      <div style={{ maxWidth: 440, margin: '64px auto 0', padding: '0 24px', textAlign: 'center' }}>
        <div style={{ fontSize: 12, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--accent)', marginBottom: 8 }}>
          No coverage yet
        </div>
        <h2 style={{ fontSize: 19, fontWeight: 700, color: 'var(--text-primary)', margin: '0 0 8px' }}>
          A grounded ledger in one exercise
        </h2>
        <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.55 }}>
          {railOpen ? '← Add source docs' : 'Open the Docs rail to add source docs'} in the rail, then <strong style={{ color: 'var(--text-primary)' }}>Generate</strong>.
          Canary extracts requirements with stable ids and maps your tests to them — summary and coverage together.
        </p>
      </div>
    </div>
  )
}

function statusOf(rc: RequirementCoverage): CoverageStatus {
  if (rc.coverageStatus) return rc.coverageStatus
  if (rc.gapType === 'verified') return 'covered'
  if (rc.gapType === 'untested') return 'uncovered'
  return 'partial'
}

// One-line headline pill (Generating / Setup needed / Stale / No coverage / Covered N%).
// A coloured dot carries the state; the dot pulses while generating.
function HeadlinePill({ headline }: { headline: string }) {
  const generating = headline === 'Generating'
  const tone = headline.startsWith('Covered')
    ? 'rgb(52, 211, 153)'
    : generating
      ? 'rgb(56, 189, 248)'
      : headline === 'Stale'
        ? 'rgb(251, 191, 36)'
        : 'var(--text-muted)'
  return (
    <span
      data-testid="coverage-state-headline"
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        fontSize: 11.5, fontWeight: 600, color: tone,
        border: `1px solid color-mix(in srgb, ${tone} 55%, transparent)`,
        background: `color-mix(in srgb, ${tone} 12%, transparent)`,
        borderRadius: 999, padding: '3px 10px',
      }}
    >
      <span
        className={generating ? 'cl-pulse' : undefined}
        aria-hidden="true"
        style={{ width: 6, height: 6, borderRadius: '50%', background: tone, boxShadow: generating ? `0 0 8px ${tone}` : 'none' }}
      />
      {headline}
    </span>
  )
}

// Persisted Docs-rail open/closed state (R12/R22) — reopening/refresh keeps it.
const RAIL_PREF_KEY = 'cl.coverage.rail'
function readRailPref(): boolean {
  try { return localStorage.getItem(RAIL_PREF_KEY) !== 'closed' } catch { return true }
}
function writeRailPref(open: boolean): void {
  try { localStorage.setItem(RAIL_PREF_KEY, open ? 'open' : 'closed') } catch { /* ignore */ }
}

function CoverageHeader({ ledger, gapFilter, onToggleGap }: { ledger: CoverageLedger; gapFilter: GapType | null; onToggleGap: (g: GapType) => void }) {
  return (
    <div className="clcov-statbar shrink-0">
      <CoverageRing pct={ledger.coveragePct} />
      <div className="clcov-chips">
        {BADGE_ORDER.map((g) => {
          const count = countFor(ledger, g)
          const meta = GAP_META[g]
          const on = gapFilter === g
          const empty = count === 0
          return (
            <button
              key={g}
              type="button"
              className="clcov-chip"
              data-testid={`gap-badge-${g}`}
              aria-pressed={on}
              data-on={on ? 'true' : 'false'}
              data-empty={empty ? 'true' : 'false'}
              onClick={() => onToggleGap(g)}
              style={{ ['--chip' as string]: meta.color }}
            >
              <span className="clcov-chip-dot" style={{ background: meta.color }} />
              {meta.label}
              <strong className="clcov-chip-n">{count}</strong>
            </button>
          )
        })}
      </div>
      <div className="clcov-verified ml-auto">
        <span className="clcov-verified-n"><strong>{ledger.totals.verified}</strong><span>/{ledger.totals.total}</span></span>
        <span className="clcov-verified-label">requirements verified</span>
        {ledger.orphanRequirementIds.length > 0 && (
          <span data-testid="orphan-note" className="clcov-orphan-note" title={ledger.orphanRequirementIds.join(', ')}>
            {ledger.orphanRequirementIds.length} orphan annotation{ledger.orphanRequirementIds.length > 1 ? 's' : ''}
          </span>
        )}
      </div>
    </div>
  )
}

function countFor(ledger: CoverageLedger, g: GapType): number {
  switch (g) {
    case 'untested': return ledger.totals.untested
    case 'unverified': return ledger.totals.unverified
    case 'path-incomplete': return ledger.totals.pathIncomplete
    case 'shallow-verified': return ledger.totals.shallowVerified
    case 'verified': return ledger.totals.verified
  }
}

// Hero stat: the grounded coverage %. Static SVG (no animation — headless preview
// forces reduced-motion). Ring hue tracks the number: green high, amber mid, muted
// low — the colour itself reads the health at a glance.
function CoverageRing({ pct }: { pct: number }) {
  const r = 26
  const c = 2 * Math.PI * r
  const clamped = Math.max(0, Math.min(100, pct))
  const offset = c * (1 - clamped / 100)
  const hue = clamped >= 80 ? 'rgb(52, 211, 153)' : clamped >= 40 ? 'rgb(251, 191, 36)' : clamped > 0 ? 'rgb(251, 113, 133)' : 'var(--text-muted)'
  return (
    <div style={{ position: 'relative', width: 66, height: 66, flexShrink: 0 }} data-testid="coverage-ring" aria-label={`${pct}% verified`}>
      <svg width={66} height={66} viewBox="0 0 66 66">
        <circle cx={33} cy={33} r={r} fill="none" stroke="var(--border-default)" strokeWidth={5} />
        <circle
          cx={33} cy={33} r={r} fill="none" stroke={hue} strokeWidth={5}
          strokeDasharray={c} strokeDashoffset={offset} strokeLinecap="round"
          transform="rotate(-90 33 33)"
        />
      </svg>
      <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', lineHeight: 1 }}>
        <span style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)' }}>{Math.round(pct)}<span style={{ fontSize: 9, fontWeight: 600 }}>%</span></span>
        <span style={{ fontSize: 8, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-muted)', marginTop: 2 }}>verified</span>
      </div>
    </div>
  )
}

function RequirementCard({ rc, colors, active, dimmed, onHover }: {
  rc: RequirementCoverage
  colors: string[]
  active: boolean
  dimmed: boolean
  onHover: (on: boolean) => void
}) {
  const meta = GAP_META[rc.gapType]
  const rigor = rc.rigor
  return (
    <div
      className="clcov-card"
      data-testid={`req-${rc.requirement.id}`}
      data-active={active ? 'true' : 'false'}
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
      style={{
        position: 'relative',
        marginBottom: 8,
        padding: '11px 13px 11px 15px',
        borderRadius: 'var(--radius-md)',
        background: active ? 'var(--bg-selected)' : 'var(--bg-surface)',
        border: '1px solid var(--border-default)',
        borderLeft: `3px solid ${colors[0] ?? 'var(--border-default)'}`,
        opacity: dimmed ? 0.4 : 1,
        transition: 'opacity 120ms, background 120ms, border-color 140ms',
      }}
    >
      <div className="flex items-center gap-2" style={{ marginBottom: 5 }}>
        <span style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 10.5, fontWeight: 600, color: 'var(--text-muted)', background: 'var(--bg-base)', border: '1px solid var(--border-default)', borderRadius: 5, padding: '1px 5px' }}>{rc.requirement.id}</span>
        <strong style={{ fontSize: 13, color: 'var(--text-primary)' }}>{rc.requirement.title}</strong>
        {rc.requirement.deprecated && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>(deprecated)</span>}
        <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 10, fontWeight: 600, color: meta.color, background: `color-mix(in srgb, ${meta.color} 12%, transparent)`, border: `1px solid color-mix(in srgb, ${meta.color} 40%, transparent)`, borderRadius: 999, padding: '2px 8px' }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: meta.color }} />
          {meta.label}
        </span>
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.45 }}>{rc.requirement.text}</div>
      <div className="flex flex-wrap items-center gap-2" style={{ marginTop: 7 }}>
        {rc.pathCoverage.map((p) => (
          <span key={p.path} style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 9.5, letterSpacing: '0.02em', padding: '1px 6px', borderRadius: 5, border: `1px solid ${p.verified ? 'color-mix(in srgb, rgb(52,211,153) 40%, var(--border-default))' : 'var(--border-default)'}`, color: p.verified ? 'rgb(52,211,153)' : 'var(--text-muted)' }}>
            {p.path} {p.verified ? '✓' : '○'}
          </span>
        ))}
        {rigor && rigor.tierReached != null && rigor.tierAvailable != null && (
          <span
            data-testid={`strictness-${rc.requirement.id}`}
            title={rigor.suggestedStrongerCheck ? `Stronger check: ${rigor.suggestedStrongerCheck}` : undefined}
            style={{
              fontSize: 10, padding: '1px 6px', borderRadius: 6, marginLeft: 'auto',
              border: `1px solid ${rc.gapType === 'shallow-verified' ? 'rgb(251,191,36)' : 'var(--border-default)'}`,
              color: rc.gapType === 'shallow-verified' ? 'rgb(251,191,36)' : 'var(--text-secondary)',
            }}
          >
            strictness tier {rigor.tierReached}/{rigor.tierAvailable}
          </span>
        )}
      </div>
    </div>
  )
}

// R9: no decorative accent border — the verified dot + covers tags carry the
// meaning. The test's `@req-*` / `@path-*` tags are surfaced as chips.
function TestCard({ test, color, active, dimmed, loading, onHover }: {
  test: TestCoverage
  color: string
  active: boolean
  dimmed: boolean
  loading?: boolean
  onHover: (on: boolean) => void
}) {
  return (
    <div
      className="clcov-card"
      data-testid={`test-${test.name}`}
      data-active={active ? 'true' : 'false'}
      onMouseEnter={loading ? undefined : () => onHover(true)}
      onMouseLeave={loading ? undefined : () => onHover(false)}
      style={{
        marginBottom: 8,
        padding: '11px 13px',
        borderRadius: 'var(--radius-md)',
        background: active ? 'var(--bg-selected)' : 'var(--bg-surface)',
        border: '1px solid var(--border-default)',
        boxShadow: active ? `inset 3px 0 0 ${color}` : 'none',
        opacity: dimmed ? 0.4 : 1,
        transition: 'opacity 120ms, background 120ms, box-shadow 120ms, border-color 140ms',
      }}
    >
      <div className="flex items-center gap-2">
        <span
          title={test.verified ? 'Has a passing run' : 'No passing run yet'}
          style={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0, background: test.verified ? 'rgb(52,211,153)' : 'rgb(251,113,133)', boxShadow: test.verified ? '0 0 6px color-mix(in srgb, rgb(52,211,153) 70%, transparent)' : 'none' }}
        />
        <strong style={{ fontSize: 13, color: 'var(--text-primary)' }}>{test.name}</strong>
        {test.file && (
          <span style={{ marginLeft: 'auto', fontFamily: 'var(--font-mono, monospace)', fontSize: 10, color: 'var(--text-muted)' }}>{test.file}{test.line ? `:${test.line}` : ''}</span>
        )}
      </div>
      {loading ? (
        // The mapping is being recomputed — show skeleton chips, not stale ones.
        <div data-testid={`test-mapping-loading-${test.name}`} className="flex items-center gap-1.5" style={{ marginTop: 7 }} aria-hidden="true">
          <span className="clcov-skel" style={{ width: 56, height: 15 }} />
          <span className="clcov-skel" style={{ width: 42, height: 15 }} />
          <span className="clcov-skel" style={{ width: 68, height: 15 }} />
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-1.5" style={{ marginTop: 7 }}>
          {test.requirements.length === 0 && (
            <span data-testid={`orphan-${test.name}`} style={{ fontSize: 10, fontWeight: 600, color: 'rgb(251, 191, 36)', background: 'color-mix(in srgb, rgb(251,191,36) 12%, transparent)', border: '1px solid color-mix(in srgb, rgb(251,191,36) 40%, transparent)', borderRadius: 999, padding: '1px 8px' }}>orphan — no covers tag</span>
          )}
          {test.requirements.map((id) => (
            <span key={id} style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 10, padding: '1px 6px', borderRadius: 5, background: `color-mix(in srgb, ${color} 14%, transparent)`, border: `1px solid color-mix(in srgb, ${color} 55%, transparent)`, color: 'var(--text-primary)' }}>@req-{id}</span>
          ))}
          {test.pathTypes.map((p) => (
            <span key={p} style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 10, padding: '1px 6px', borderRadius: 5, border: '1px solid var(--border-default)', color: 'var(--text-muted)' }}>@path-{p}</span>
          ))}
        </div>
      )}
      {!loading && test.verified && test.lastPassingRun && (
        <div style={{ marginTop: 5, fontSize: 10, color: 'var(--text-muted)' }}>
          last pass: run {test.lastPassingRun.runId}{test.lastPassingRun.env ? ` · ${test.lastPassingRun.env}` : ''}
        </div>
      )}
    </div>
  )
}

// R19 redesign: the dialog's chrome + interaction polish, kept in the operator-
// console token system (no new fonts, no component library). Motion is restrained
// and reduced-motion-safe; meaning carries the colour (cl_ui-design-philosophy).
const COVERAGE_CSS = `
.clcov-head{position:relative;display:flex;align-items:center;gap:14px;padding:10px 18px;border-bottom:1px solid var(--border-default);background:color-mix(in srgb,var(--bg-surface) 55%,var(--bg-base))}
.clcov-head::after{content:'';position:absolute;left:0;right:0;bottom:-1px;height:2px;background:transparent;transition:background .2s}
.clcov-head[data-generating='true']::after{background:linear-gradient(90deg,transparent,rgb(56,189,248),transparent);background-size:200% 100%;animation:clcov-sheen 1.6s linear infinite}
@keyframes clcov-sheen{0%{background-position:200% 0}100%{background-position:-200% 0}}
@media (prefers-reduced-motion:reduce){.clcov-head[data-generating='true']::after{animation:none;background:rgb(56,189,248)}}
.clcov-title{display:flex;flex-direction:column;line-height:1.18;min-width:0}
.clcov-eyebrow{font-size:9px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:var(--text-muted)}
.clcov-feature{font-size:14px;font-weight:700;color:var(--text-primary);font-family:var(--font-mono,monospace);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:40ch}
.clcov-close{appearance:none;cursor:pointer;font-size:12px;font-weight:600;color:var(--text-secondary);background:var(--bg-surface);border:1px solid var(--border-default);border-radius:var(--radius-md);padding:6px 12px;transition:background .14s,color .14s,border-color .14s}
.clcov-close:hover{color:var(--text-primary);background:var(--bg-selected);border-color:color-mix(in srgb,var(--text-muted) 45%,var(--border-default))}
.clcov-statbar{display:flex;align-items:center;gap:20px;padding:13px 18px;border-bottom:1px solid var(--border-default);background:color-mix(in srgb,var(--bg-surface) 30%,var(--bg-base))}
.clcov-chips{display:flex;flex-wrap:wrap;align-items:center;gap:7px}
.clcov-chip{display:inline-flex;align-items:center;gap:7px;appearance:none;cursor:pointer;font-size:11.5px;color:var(--text-primary);background:var(--bg-surface);border:1px solid var(--border-default);border-radius:999px;padding:4px 11px;transition:background .14s,border-color .14s,opacity .14s,transform .1s}
.clcov-chip:hover{transform:translateY(-1px)}
.clcov-chip[data-empty='true']{opacity:.5}
.clcov-chip[data-on='true']{background:color-mix(in srgb,var(--chip) 14%,var(--bg-surface));border-color:color-mix(in srgb,var(--chip) 60%,transparent);box-shadow:0 0 0 1px color-mix(in srgb,var(--chip) 30%,transparent) inset}
.clcov-chip-dot{width:7px;height:7px;border-radius:50%;flex:none}
.clcov-chip-n{font-variant-numeric:tabular-nums}
.clcov-verified{display:flex;flex-direction:column;align-items:flex-end;line-height:1.2}
.clcov-verified-n{font-size:15px;color:var(--text-secondary)}
.clcov-verified-n strong{font-size:18px;color:var(--text-primary);font-variant-numeric:tabular-nums}
.clcov-verified-n span{margin-left:1px}
.clcov-verified-label{font-size:9px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--text-muted);margin-top:2px}
.clcov-orphan-note{margin-top:4px;font-size:10px;color:rgb(251,191,36)}
.clcov-card:hover{border-color:color-mix(in srgb,var(--text-muted) 38%,var(--border-default))}
.cl-pulse{animation:clcov-pulse 1.4s ease-in-out infinite}
@keyframes clcov-pulse{0%,100%{opacity:1}50%{opacity:.4}}
.clcov-skel{display:inline-block;border-radius:5px;background:color-mix(in srgb,var(--text-muted) 16%,var(--bg-base));position:relative;overflow:hidden}
.clcov-skel::after{content:'';position:absolute;inset:0;transform:translateX(-100%);background:linear-gradient(90deg,transparent,color-mix(in srgb,var(--text-muted) 22%,transparent),transparent);animation:clcov-skel-sweep 1.3s ease-in-out infinite}
@keyframes clcov-skel-sweep{100%{transform:translateX(100%)}}
@media (prefers-reduced-motion:reduce){.cl-pulse{animation:none}.clcov-skel::after{animation:none}}
`
