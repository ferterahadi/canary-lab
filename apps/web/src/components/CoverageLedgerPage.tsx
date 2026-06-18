import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as api from '../api/client'
import type {
  CoverageJobKind,
  CoverageJobManifest,
  CoverageLedger,
  CoverageStatus,
  GapType,
  RequirementCoverage,
  TestCoverage,
} from '../api/types'
import { CoverageDocsTab } from './CoverageDocsTab'
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
  // Sub-tab persists across refresh (R12) so reopening lands where you left off.
  const [tab, setTab] = useState<'ledger' | 'docs'>(() => (readTabPref() === 'docs' ? 'docs' : 'ledger'))
  // Source-doc count drives the setup guide (step ② unlocks once ≥1 doc exists).
  const [sourceDocCount, setSourceDocCount] = useState<number | null>(null)

  // Async generation (R4 jobs). Summary + Coverage are ONE exercise (R14): a
  // summary job auto-chains a coverage job, and we follow that chain so the
  // single `job` here represents whichever phase is live. While a job runs the
  // Coverage tab shows a dedicated Generating screen (R13) — not the ledger.
  const [job, setJob] = useState<CoverageJobManifest | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const selectTab = useCallback((t: 'ledger' | 'docs') => { setTab(t); writeTabPref(t) }, [])

  const loadDocsCount = useCallback(() => {
    api.listFeatureDocs(feature)
      .then((d) => setSourceDocCount(d.sourceDocCount))
      .catch(() => {})
  }, [feature])

  const refresh = useCallback(() => {
    setLoading(true)
    api.getFeatureCoverage(feature)
      .then((data) => { setLedger(data); setError(null) })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false))
    loadDocsCount()
  }, [feature, loadDocsCount])

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
            // Summary done → follow the auto-chained coverage job (R14): keep the
            // Generating screen up across both phases, no second click.
            refresh()
            pollJob(m.chainedJobId)
          } else {
            if (m.status === 'failed') setActionError(m.error ?? 'generation failed')
            setJob(null)
            refresh()
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
      .catch((e: unknown) => setActionError(e instanceof Error ? e.message : String(e)))
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

  return (
    <div className="fixed inset-0 z-[60] flex flex-col" style={{ background: 'var(--bg-base)' }} data-testid="coverage-ledger">
      <div className="flex shrink-0 items-center gap-4 border-b px-5 py-3" style={{ borderColor: 'var(--border-default)' }}>
        <div style={{ display: 'inline-flex', border: '1px solid var(--border-default)', borderRadius: 'var(--radius-md)', overflow: 'hidden' }}>
          {(['ledger', 'docs'] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => selectTab(t)}
              aria-pressed={tab === t}
              style={{
                background: tab === t ? 'var(--bg-selected)' : 'var(--bg-surface)',
                color: tab === t ? 'var(--text-primary)' : 'var(--text-secondary)',
                border: 'none',
                borderRight: t === 'ledger' ? '1px solid var(--border-default)' : 'none',
                padding: '6px 16px',
                fontSize: 14,
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              {t === 'ledger' ? 'Coverage' : 'Docs'}
            </button>
          ))}
        </div>
        <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
          Verified Coverage · <strong style={{ color: 'var(--text-primary)' }}>{feature}</strong>
        </span>
        {ledger?.state && <HeadlinePill headline={ledger.state.headline} />}
        <button type="button" onClick={onClose} className="cl-button ml-auto px-3 py-1.5" aria-label="Close coverage">
          Close ✕
        </button>
      </div>

      {loading && !ledger && <div className="p-6" style={{ color: 'var(--text-secondary)' }}>Loading coverage…</div>}
      {error && <div className="p-6" style={{ color: 'rgb(251, 113, 133)' }}>Failed to load coverage: {error}</div>}

      {!error && ledger && tab === 'docs' && (
        <CoverageDocsTab feature={feature} onRegenerated={refresh} onDocsChanged={loadDocsCount} />
      )}

      {/* Generating (R13): while a job runs, the Coverage tab is ONE dedicated
          screen — never the ledger, never the empty/setup state. Summary + Coverage
          are one exercise, so this spans both phases (R14). */}
      {!error && ledger && tab === 'ledger' && job && (
        <CoverageGeneratingPane feature={feature} job={job} />
      )}

      {/* ABSENT summary → the setup guide IS the content (no dead-end panes). */}
      {!error && ledger && tab === 'ledger' && !job && ledger.state?.summary === 'absent' && (
        <CoverageSetupGuide
          sourceDocCount={sourceDocCount}
          actionError={actionError}
          onAddDocs={() => selectTab('docs')}
          onGenerate={() => startJob('summary')}
        />
      )}

      {!error && ledger && tab === 'ledger' && !job && ledger.state?.summary !== 'absent' && (
        <>
          {ledger.state && (
            <StateBanner
              ledger={ledger}
              onGenerate={startJob}
              actionError={actionError}
            />
          )}
          <CoverageHeader ledger={ledger} gapFilter={gapFilter} onToggleGap={(g) => setGapFilter((cur) => (cur === g ? null : g))} />
          <div className="flex min-h-0 flex-1">
            {/* PRD / requirements pane */}
            <div className="min-h-0 flex-1 overflow-auto border-r p-4" style={{ borderColor: 'var(--border-default)' }} data-testid="prd-pane">
              {visibleReqs.length === 0 && (
                <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>
                  {ledger.requirements.length === 0 ? 'No PRD requirements yet. Add docs and generate the PRD summary.' : 'No requirements match this filter.'}
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
            {/* Tests pane */}
            <div className="min-h-0 flex-1 overflow-auto p-4" data-testid="tests-pane">
              {ledger.tests.length === 0 && (
                <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>No tests found in this feature&apos;s specs.</div>
              )}
              {orphanTests.length > 0 && (
                <div data-testid="orphan-tests-note" style={{ marginBottom: 10, fontSize: 11, color: 'rgb(251, 191, 36)' }}>
                  {orphanTests.length} orphan test{orphanTests.length > 1 ? 's' : ''} (no requirement) — regenerate coverage to map them.
                </div>
              )}
              {ledger.tests.map((t) => (
                <TestCard
                  key={t.name}
                  test={t}
                  color={colorByTest.get(t.name)!}
                  active={activeTestNames.has(t.name)}
                  dimmed={Boolean(hovered) && !activeTestNames.has(t.name)}
                  onHover={(on) => setHovered(on ? { kind: 'test', key: t.name } : null)}
                />
              ))}
            </div>
          </div>
        </>
      )}
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
function HeadlinePill({ headline }: { headline: string }) {
  const tone = headline.startsWith('Covered')
    ? 'rgb(52, 211, 153)'
    : headline === 'Generating'
      ? 'rgb(56, 189, 248)'
      : headline === 'Stale'
        ? 'rgb(251, 191, 36)'
        : 'var(--text-muted)'
  return (
    <span
      data-testid="coverage-state-headline"
      style={{ fontSize: 12, fontWeight: 600, color: tone, border: `1px solid ${tone}`, borderRadius: 'var(--radius-md)', padding: '2px 8px' }}
    >
      {headline}
    </span>
  )
}

// State-driven action bar — never a dead end. Shows the right generate action for
// the current (summary × coverage) state and, when stale, names the changed docs
// + affected artifacts.
function StateBanner({ ledger, onGenerate, actionError }: {
  ledger: CoverageLedger
  onGenerate: (kind: CoverageJobKind) => void
  actionError: string | null
}) {
  const state = ledger.state!
  const drift = state.drift
  const summaryStale = state.summary === 'stale'
  const coverageActionable = state.summary === 'fresh'
  return (
    <div
      data-testid="coverage-state-banner"
      className="flex shrink-0 flex-wrap items-center gap-3 border-b px-5 py-2.5"
      style={{ borderColor: 'var(--border-default)', background: 'var(--bg-surface)' }}
    >
      {summaryStale && (
        <span data-testid="drift-banner" style={{ fontSize: 12, color: 'rgb(251, 191, 36)' }}>
          Stale: {drift.changedDocs.length ? `${drift.changedDocs.join(', ')} changed` : 'docs changed'}
          {drift.affectedArtifacts.length ? ` → affects ${drift.affectedArtifacts.join(' + ')}` : ''}
          {' — regenerate the summary to refresh coverage.'}
        </span>
      )}
      {state.coverage === 'stale' && !summaryStale && (
        <span data-testid="coverage-stale-note" style={{ fontSize: 12, color: 'rgb(251, 191, 36)' }}>
          Requirements changed since the engine last ran — regenerate coverage.
        </span>
      )}
      <div className="ml-auto flex items-center gap-2">
        {/* Summary + Coverage are one exercise: regenerating the summary re-runs
            coverage automatically (R16). "Regenerate coverage" re-maps against the
            current summary only. */}
        <button
          type="button"
          data-testid="generate-summary"
          onClick={() => onGenerate('summary')}
          className="cl-button px-3 py-1"
          title="Re-summarize the docs, then re-map coverage (one exercise)"
          style={{ fontSize: 12 }}
        >
          Regenerate summary
        </button>
        <button
          type="button"
          data-testid="generate-coverage"
          disabled={!coverageActionable}
          onClick={() => onGenerate('coverage')}
          className="cl-button px-3 py-1"
          title={coverageActionable ? 'Re-map covers tags against the current summary' : 'Generate a fresh PRD summary first'}
          style={{ fontSize: 12, opacity: coverageActionable ? 1 : 0.5 }}
        >
          Regenerate coverage
        </button>
      </div>
      {actionError && <span style={{ width: '100%', fontSize: 11, color: 'rgb(251, 113, 133)' }}>{actionError}</span>}
    </div>
  )
}

// Guided empty state for the ABSENT summary — the two-step setup flow. Step ②
// stays locked until ≥1 source doc exists, so the next action is always obvious.
function CoverageSetupGuide({ sourceDocCount, actionError, onAddDocs, onGenerate }: {
  sourceDocCount: number | null
  actionError: string | null
  onAddDocs: () => void
  onGenerate: () => void
}) {
  const hasDocs = (sourceDocCount ?? 0) > 0
  return (
    <div className="min-h-0 flex-1 overflow-auto" data-testid="coverage-setup-guide">
      <div style={{ maxWidth: 520, margin: '48px auto 0', padding: '0 24px' }}>
        <div style={{ fontSize: 12, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--accent)' }}>
          Set up Verified Coverage
        </div>
        <h2 style={{ fontSize: 20, fontWeight: 700, color: 'var(--text-primary)', margin: '6px 0 6px' }}>
          Two steps to a grounded coverage ledger
        </h2>
        <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5, marginBottom: 22 }}>
          Canary extracts testable requirements from your docs, then grounds each one against the tests that actually pass.
        </p>

        <SetupStep
          n={1}
          active={!hasDocs}
          done={hasDocs}
          title="Add source docs"
          body="Drop in specs, tickets, or notes (.md / .txt / .pdf / .docx — multiple at once). Requirements are extracted from these."
          cta={hasDocs ? `${sourceDocCount} source doc${sourceDocCount! > 1 ? 's' : ''} added — add more` : 'Add docs'}
          ctaTestId="setup-add-docs"
          onClick={onAddDocs}
        />
        <SetupStep
          n={2}
          active={hasDocs}
          done={false}
          title="Generate the PRD summary + coverage"
          body="Canary summarizes the docs into requirements with stable ids, then maps your tests to them — one exercise. Regenerate any time; ids are preserved."
          cta="Generate"
          ctaTestId="setup-generate-summary"
          onClick={onGenerate}
          disabled={!hasDocs}
          disabledHint={!hasDocs ? 'Add a source doc first' : undefined}
          primary
        />

        {actionError && <div style={{ marginTop: 14, fontSize: 12, color: 'rgb(251, 113, 133)' }}>{actionError}</div>}
      </div>
    </div>
  )
}

function SetupStep({ n, active, done, title, body, cta, ctaTestId, onClick, disabled, disabledHint, primary }: {
  n: number
  active: boolean
  done: boolean
  title: string
  body: string
  cta: string
  ctaTestId: string
  onClick: () => void
  disabled?: boolean
  disabledHint?: string
  primary?: boolean
}) {
  return (
    <div
      data-testid={`setup-step-${n}`}
      data-active={active ? 'true' : 'false'}
      style={{
        display: 'flex', gap: 14, padding: 16, marginBottom: 12,
        borderRadius: 'var(--radius-md)',
        border: `1px solid ${active ? 'color-mix(in srgb, var(--accent) 45%, var(--border-default))' : 'var(--border-default)'}`,
        background: active ? 'color-mix(in srgb, var(--accent) 7%, var(--bg-surface))' : 'var(--bg-surface)',
        opacity: !active && !done ? 0.6 : 1,
        transition: 'opacity 150ms, border-color 150ms, background 150ms',
      }}
    >
      <div
        aria-hidden="true"
        style={{
          flexShrink: 0, width: 26, height: 26, borderRadius: '50%',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 13, fontWeight: 700,
          background: done ? 'rgb(52, 211, 153)' : active ? 'var(--accent)' : 'var(--bg-base)',
          color: done || active ? '#0b0f17' : 'var(--text-muted)',
          border: done || active ? 'none' : '1px solid var(--border-default)',
        }}
      >
        {done ? '✓' : n}
      </div>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>{title}</div>
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.45, margin: '4px 0 10px' }}>{body}</div>
        <button
          type="button"
          data-testid={ctaTestId}
          onClick={onClick}
          disabled={disabled}
          title={disabled && disabledHint ? disabledHint : undefined}
          className="cl-button px-3 py-1.5"
          style={primary && !disabled ? { background: 'var(--accent)', color: '#0b0f17', borderColor: 'var(--accent)', fontWeight: 600 } : undefined}
        >
          {cta}
        </button>
      </div>
    </div>
  )
}

// Persisted Coverage sub-tab (R12) — reopening/refresh lands on the last tab.
const TAB_PREF_KEY = 'cl.coverage.subtab'
function readTabPref(): string | null {
  try { return localStorage.getItem(TAB_PREF_KEY) } catch { return null }
}
function writeTabPref(tab: 'ledger' | 'docs'): void {
  try { localStorage.setItem(TAB_PREF_KEY, tab) } catch { /* ignore */ }
}

function CoverageHeader({ ledger, gapFilter, onToggleGap }: { ledger: CoverageLedger; gapFilter: GapType | null; onToggleGap: (g: GapType) => void }) {
  return (
    <div className="flex shrink-0 items-center gap-6 border-b px-5 py-3" style={{ borderColor: 'var(--border-default)' }}>
      <CoverageRing pct={ledger.coveragePct} />
      <div className="flex flex-wrap items-center gap-2">
        {BADGE_ORDER.map((g) => {
          const count = countFor(ledger, g)
          const meta = GAP_META[g]
          const on = gapFilter === g
          return (
            <button
              key={g}
              type="button"
              data-testid={`gap-badge-${g}`}
              aria-pressed={on}
              onClick={() => onToggleGap(g)}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                background: on ? 'var(--bg-selected)' : 'var(--bg-surface)',
                border: `1px solid ${count > 0 ? meta.color : 'var(--border-default)'}`,
                borderRadius: 'var(--radius-md)', padding: '3px 10px', fontSize: 12, cursor: 'pointer',
                color: 'var(--text-primary)', opacity: count > 0 ? 1 : 0.5,
              }}
            >
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: meta.color }} />
              {meta.label}
              <strong>{count}</strong>
            </button>
          )
        })}
      </div>
      <div className="ml-auto" style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
        <strong style={{ color: 'var(--text-primary)' }}>{ledger.totals.verified}</strong> / {ledger.totals.total} requirements verified
        {ledger.orphanRequirementIds.length > 0 && (
          <span data-testid="orphan-note" title={ledger.orphanRequirementIds.join(', ')} style={{ marginLeft: 12, color: 'rgb(251, 191, 36)' }}>
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

function CoverageRing({ pct }: { pct: number }) {
  const r = 22
  const c = 2 * Math.PI * r
  const offset = c * (1 - Math.max(0, Math.min(100, pct)) / 100)
  return (
    <div style={{ position: 'relative', width: 56, height: 56 }} data-testid="coverage-ring" aria-label={`${pct}% verified`}>
      <svg width={56} height={56} viewBox="0 0 56 56">
        <circle cx={28} cy={28} r={r} fill="none" stroke="var(--border-default)" strokeWidth={5} />
        <circle
          cx={28} cy={28} r={r} fill="none" stroke="rgb(52, 211, 153)" strokeWidth={5}
          strokeDasharray={c} strokeDashoffset={offset} strokeLinecap="round"
          transform="rotate(-90 28 28)"
        />
      </svg>
      <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>
        {Math.round(pct)}%
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
      data-testid={`req-${rc.requirement.id}`}
      data-active={active ? 'true' : 'false'}
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
      style={{
        position: 'relative',
        marginBottom: 10,
        padding: '10px 12px 10px 14px',
        borderRadius: 'var(--radius-md)',
        background: active ? 'var(--bg-selected)' : 'var(--bg-surface)',
        border: '1px solid var(--border-default)',
        borderLeft: `4px solid ${colors[0] ?? 'var(--border-default)'}`,
        opacity: dimmed ? 0.45 : 1,
        transition: 'opacity 120ms, background 120ms',
      }}
    >
      <div className="flex items-center gap-2" style={{ marginBottom: 4 }}>
        <span style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 12, color: 'var(--text-secondary)' }}>{rc.requirement.id}</span>
        <strong style={{ fontSize: 13, color: 'var(--text-primary)' }}>{rc.requirement.title}</strong>
        {rc.requirement.deprecated && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>(deprecated)</span>}
        <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, color: meta.color }}>
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: meta.color }} />
          {meta.label}
        </span>
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.45 }}>{rc.requirement.text}</div>
      <div className="flex flex-wrap items-center gap-2" style={{ marginTop: 6 }}>
        {rc.pathCoverage.map((p) => (
          <span key={p.path} style={{ fontSize: 10, padding: '1px 6px', borderRadius: 6, border: '1px solid var(--border-default)', color: p.verified ? 'rgb(52,211,153)' : 'var(--text-muted)' }}>
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
function TestCard({ test, color, active, dimmed, onHover }: {
  test: TestCoverage
  color: string
  active: boolean
  dimmed: boolean
  onHover: (on: boolean) => void
}) {
  return (
    <div
      data-testid={`test-${test.name}`}
      data-active={active ? 'true' : 'false'}
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
      style={{
        marginBottom: 10,
        padding: '10px 12px',
        borderRadius: 'var(--radius-md)',
        background: active ? 'var(--bg-selected)' : 'var(--bg-surface)',
        border: '1px solid var(--border-default)',
        boxShadow: active ? `inset 3px 0 0 ${color}` : 'none',
        opacity: dimmed ? 0.45 : 1,
        transition: 'opacity 120ms, background 120ms, box-shadow 120ms',
      }}
    >
      <div className="flex items-center gap-2">
        <span
          title={test.verified ? 'Has a passing run' : 'No passing run yet'}
          style={{ width: 9, height: 9, borderRadius: '50%', background: test.verified ? 'rgb(52,211,153)' : 'rgb(251,113,133)', flexShrink: 0 }}
        />
        <strong style={{ fontSize: 13, color: 'var(--text-primary)' }}>{test.name}</strong>
        {test.file && (
          <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--text-muted)' }}>{test.file}{test.line ? `:${test.line}` : ''}</span>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-1.5" style={{ marginTop: 6 }}>
        {test.requirements.length === 0 && (
          <span data-testid={`orphan-${test.name}`} style={{ fontSize: 10, color: 'rgb(251, 191, 36)' }}>orphan — no covers tag</span>
        )}
        {test.requirements.map((id) => (
          <span key={id} style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 10, padding: '1px 6px', borderRadius: 6, background: 'color-mix(in srgb, var(--bg-base) 70%, transparent)', border: `1px solid ${color}`, color: 'var(--text-secondary)' }}>@req-{id}</span>
        ))}
        {test.pathTypes.map((p) => (
          <span key={p} style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 10, padding: '1px 6px', borderRadius: 6, border: '1px solid var(--border-default)', color: 'var(--text-muted)' }}>@path-{p}</span>
        ))}
      </div>
      {test.verified && test.lastPassingRun && (
        <div style={{ marginTop: 4, fontSize: 10, color: 'var(--text-muted)' }}>
          last pass: run {test.lastPassingRun.runId}{test.lastPassingRun.env ? ` · ${test.lastPassingRun.env}` : ''}
        </div>
      )}
    </div>
  )
}
