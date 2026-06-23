import { type KeyboardEvent as ReactKeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as api from '../../../shared/api/client'
import type {
  CoverageJobKind,
  CoverageJobManifest,
  CoverageLedger,
  CoverageStatus,
  FeatureTests,
  GapType,
  RequirementCoverage,
  TestCoverage,
  TestStrength,
} from '../../../shared/api/types'
import { CoverageDocsRail } from './CoverageDocsRail'
import { CoverageGeneratingPane } from './CoverageGeneratingPane'
import { ShikiCode } from '../../../shared/ui/TestCodeBlock'
import { TestIdBadge } from '../../../shared/ui/TestIdBadge'
import { buildTestNumbering, stripLeadingTestOrdinal, testNumberKey } from '../../../shared/test-numbering'

interface Props {
  feature: string
  onClose: () => void
}

// Each gap class gets a stable label + colour. Coverage is semantic (run-free):
// `untested` (no test maps to it) is the gap; `path-incomplete` (some declared
// paths unclaimed) is partial; `covered` (every path claimed) is the good state.
const GAP_META: Record<GapType, { label: string; color: string }> = {
  covered: { label: 'Covered', color: 'rgb(52, 211, 153)' },
  'path-incomplete': { label: 'Path-incomplete', color: 'rgb(56, 189, 248)' },
  untested: { label: 'Untested', color: 'var(--text-muted)' },
}

// Per-test coverage strength — graded off the strongest stack layer a test's
// assertions touch (tier classifier), independent of runs. Hues reuse the status
// language: orange/amber weak, sky mid, green strong.
const STRENGTH_META: Record<TestStrength, { label: string; color: string; title: string }> = {
  strong: { label: 'Strong', color: 'rgb(52, 211, 153)', title: 'Tier 4 — a real external destination / browser confirmed the effect' },
  solid: { label: 'Solid', color: 'rgb(56, 189, 248)', title: 'Tier 3 — an app/internal API or UI assertion reported success' },
  basic: { label: 'Basic', color: 'rgb(251, 191, 36)', title: 'Tier 2 — internal state changed (DB row / fixture)' },
  shallow: { label: 'Shallow', color: 'rgb(251, 146, 60)', title: 'Tier 1 — only the app’s own log / self-report (or no classifiable depth)' },
}
// Worst-first: the weakest tests sort to the front of the filter.
const STRENGTH_ORDER: TestStrength[] = ['shallow', 'basic', 'solid', 'strong']

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
  const [strengthFilter, setStrengthFilter] = useState<TestStrength | null>(null)
  // A @req tag on a test card jumps to (and briefly rings) its requirement card in
  // the PRD pane. Nonce so re-clicking the same id re-fires the scroll/flash.
  const [focusReq, setFocusReq] = useState<{ id: string; n: number } | null>(null)
  const prdPaneRef = useRef<HTMLDivElement>(null)
  const focusClearRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const focusNonce = useRef(0)
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

  useEffect(() => () => {
    if (pollRef.current) clearTimeout(pollRef.current)
    if (focusClearRef.current) clearTimeout(focusClearRef.current)
  }, [])

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
        .catch(() => {
          // Transient fetch error (network blip, server restart) — do NOT assume the
          // job ended (setJob(null) here would flip to a stale ledger) and do NOT
          // leave the chain dead. Re-arm so the poll recovers; the reconcile backstop
          // below owns the authoritative "is it actually over" decision.
          pollRef.current = setTimeout(tick, 1500)
        })
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

  // Self-healing backstop for the Generating screen. The per-job poll above is an
  // in-memory setTimeout chain: if a single getCoverageJob fetch HANGS (a server
  // restart from a redeploy, a suspended tab, a throttled-network stall) the chain
  // wedges and the screen shows GENERATING forever even though the job finished long
  // ago. A lost completion can't be tolerated, so independently reconcile against the
  // authoritative, file-backed job index on a fixed interval (setInterval — a hung
  // fetch just skips a tick, the next still fires). Once the server reports no running
  // job for this feature on two consecutive checks (the 2nd guards the brief
  // summary→coverage chain-handoff window so we don't clear mid-chain), the job is
  // over: drop the Generating screen and pull the fresh ledger. Self-limiting — the
  // effect only exists while generating and tears down the moment the screen clears.
  const isGenerating = job !== null
  useEffect(() => {
    if (!isGenerating) return
    let stop = false
    let idleChecks = 0
    const id = setInterval(() => {
      api.listCoverageJobs(feature)
        .then((jobs) => {
          if (stop) return
          if (jobs.some((j) => j.status === 'running')) { idleChecks = 0; return }
          idleChecks += 1
          if (idleChecks >= 2) { setJob(null); refresh(); setDocsReloadKey((k) => k + 1) }
        })
        .catch(() => {})
    }, 3000)
    return () => { stop = true; clearInterval(id) }
  }, [isGenerating, feature, refresh])

  // Stable colour per test name (by position in the ledger's test list).
  const colorByTest = useMemo(() => {
    const map = new Map<string, string>()
    ledger?.tests.forEach((t, i) => map.set(t.name, testColor(i)))
    return map
  }, [ledger])

  // Canonical per-test ids, shared with the Tests column + Playback.
  const testNumbering = useMemo(
    () => buildTestNumbering((ledger?.tests ?? []).map((t) => ({ file: t.file, line: t.line }))),
    [ledger],
  )

  // Test SOURCE is not in the ledger (it carries name/file/line/strength only).
  // Lazily fetch the feature's spec bodies the FIRST time any test card is
  // expanded — most sessions never expand one, so we don't pay the parse cost up
  // front. One fetch, cached; cards read the result via the lookup below.
  const [specSource, setSpecSource] = useState<FeatureTests | null>(null)
  const [specSourceLoading, setSpecSourceLoading] = useState(false)
  const [specSourceError, setSpecSourceError] = useState<string | null>(null)
  const specSourceReq = useRef(false)
  const ensureSpecSource = useCallback(() => {
    if (specSourceReq.current) return
    specSourceReq.current = true
    setSpecSourceLoading(true)
    api.getFeatureTests(feature)
      .then((r) => { setSpecSource(r); setSpecSourceError(null) })
      .catch((e: unknown) => setSpecSourceError(e instanceof Error ? e.message : 'Failed to load test source'))
      .finally(() => setSpecSourceLoading(false))
  }, [feature])

  // Match a ledger test to its extracted body. The ledger's `file` is relative
  // and prefers a helper `sourceFile` (so does the route via `sourceFile ?? file`),
  // so key on (basename, line) — identical AST line on both sides — with an exact
  // name as a secondary fallback. Each entry keeps the ABSOLUTE file for open-in-editor.
  const sourceByTest = useMemo(() => {
    const base = (p: string) => p.split(/[\\/]/).pop() ?? p
    const byLoc = new Map<string, { body: string; absFile: string; line: number }>()
    const byName = new Map<string, { body: string; absFile: string; line: number }>()
    for (const sf of specSource ?? []) {
      for (const t of sf.tests) {
        const absFile = t.sourceFile ?? sf.file
        const entry = { body: t.bodySource, absFile, line: t.line }
        byLoc.set(`${base(absFile)}:${t.line}`, entry)
        if (!byName.has(t.name)) byName.set(t.name, entry)
      }
    }
    return { base, byLoc, byName }
  }, [specSource])

  const lookupSource = useCallback(
    (t: TestCoverage) => {
      if (t.file && t.line != null) {
        const hit = sourceByTest.byLoc.get(`${sourceByTest.base(t.file)}:${t.line}`)
        if (hit) return hit
      }
      return sourceByTest.byName.get(t.name) ?? null
    },
    [sourceByTest],
  )

  const openTestInEditor = useCallback((absFile: string, line?: number) => {
    api.openEditor({ file: absFile, line }).catch(() => {})
  }, [])

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

  // Jump a test's `@req` tag to its requirement card. If a gap filter is hiding the
  // target, lift it first so the card is reachable, then scroll + ring it (the scroll
  // effect re-runs once visibleReqs reflects the lifted filter).
  const focusRequirement = useCallback((id: string) => {
    setGapFilter((cur) => {
      if (!cur) return cur
      const rc = ledger?.requirements.find((r) => r.requirement.id === id)
      return rc && rc.gapType === cur ? cur : null
    })
    focusNonce.current += 1
    setFocusReq({ id, n: focusNonce.current })
    if (focusClearRef.current) clearTimeout(focusClearRef.current)
    focusClearRef.current = setTimeout(() => setFocusReq(null), 1800)
  }, [ledger])

  useEffect(() => {
    if (!focusReq) return
    const el = prdPaneRef.current?.querySelector<HTMLElement>(`[data-testid="req-${focusReq.id}"]`)
    el?.scrollIntoView?.({ block: 'center', behavior: 'smooth' })
  }, [focusReq, visibleReqs])

  const generating = Boolean(job)

  const state = ledger?.state
  const summaryAbsent = state?.summary === 'absent'

  // Tests pane — shown in BOTH the final ledger and (R: 3-column generating) while
  // a job runs. While generating, the whole mapping is being recomputed, so the
  // cards are held back entirely: real names + chips would read as "already done"
  // against the middle pane's "Mapping coverage…". The pane is honestly loading,
  // so it renders placeholder skeleton cards (one per known test) — same shell, so
  // they resolve into the real cards in place once the new ledger lands.
  const testsPaneEl = ledger ? (
    <div className="min-h-0 flex-1 overflow-auto p-4" style={{ scrollbarGutter: 'stable' }} data-testid="tests-pane">
      {generating ? (
        <>
          <div data-testid="tests-remapping-note" style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 10, fontSize: 11, color: 'rgb(56, 189, 248)' }}>
            <span className="cl-pulse" aria-hidden="true" style={{ width: 6, height: 6, borderRadius: '50%', background: 'rgb(56, 189, 248)' }} />
            Mapping coverage to your tests…
          </div>
          {(ledger.tests.length > 0 ? ledger.tests : [null, null, null]).map((_, i) => (
            <TestCardSkeleton key={i} index={i} />
          ))}
        </>
      ) : (
        <>
          {ledger.tests.length === 0 && (
            <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>No tests found in this feature&apos;s specs.</div>
          )}
          {orphanTests.length > 0 && (
            <div data-testid="orphan-tests-note" style={{ marginBottom: 10, fontSize: 11, color: 'rgb(251, 191, 36)' }}>
              {orphanTests.length} orphan test{orphanTests.length > 1 ? 's' : ''} (no requirement) — regenerate coverage to map them.
            </div>
          )}
          {ledger.tests.length > 0 && (
            <div className="clcov-chips" data-testid="strength-filter" style={{ marginBottom: 12 }}>
              {STRENGTH_ORDER.map((s) => {
                const count = ledger.tests.filter((t) => (t.strength ?? 'shallow') === s).length
                const meta = STRENGTH_META[s]
                const on = strengthFilter === s
                return (
                  <button
                    key={s}
                    type="button"
                    className="clcov-chip"
                    data-testid={`strength-badge-${s}`}
                    aria-pressed={on}
                    data-on={on ? 'true' : 'false'}
                    data-empty={count === 0 ? 'true' : 'false'}
                    title={meta.title}
                    onClick={() => setStrengthFilter((cur) => (cur === s ? null : s))}
                    style={{ ['--chip' as string]: meta.color }}
                  >
                    <span className="clcov-chip-dot" style={{ background: meta.color }} />
                    {meta.label}
                    <strong className="clcov-chip-n">{count}</strong>
                  </button>
                )
              })}
            </div>
          )}
          {(strengthFilter ? ledger.tests.filter((t) => (t.strength ?? 'shallow') === strengthFilter) : ledger.tests).map((t) => (
            <TestCard
              key={t.name}
              test={t}
              testNumber={testNumbering.get(testNumberKey(t.file, t.line))}
              color={colorByTest.get(t.name)!}
              active={activeTestNames.has(t.name)}
              dimmed={Boolean(hovered) && !activeTestNames.has(t.name)}
              onHover={(on) => setHovered(on ? { kind: 'test', key: t.name } : null)}
              onExpand={ensureSpecSource}
              source={lookupSource(t)}
              sourceLoading={specSourceLoading}
              sourceError={specSourceError}
              onOpenEditor={openTestInEditor}
              onReqClick={focusRequirement}
            />
          ))}
        </>
      )}
    </div>
  ) : null

  return (
    <div className="clcov-root fixed inset-0 z-[60] flex flex-col" style={{ background: 'var(--bg-base)' }} data-testid="coverage-ledger">
      <style>{COVERAGE_CSS}</style>
      <header className="clcov-head" data-generating={generating ? 'true' : 'false'}>
        <div className="clcov-title">
          <span className="clcov-eyebrow">Semantic Coverage</span>
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
                  <div ref={prdPaneRef} className="min-h-0 flex-1 overflow-auto border-r p-4" style={{ borderColor: 'var(--border-default)', scrollbarGutter: 'stable' }} data-testid="prd-pane">
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
                        focused={focusReq?.id === rc.requirement.id}
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
  if (rc.gapType === 'covered') return 'covered'
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

// Bar/legend order reads good → gap: the green of `covered` leads, the work sinks
// right. The legend doubles as the requirement filter.
const SEG_ORDER: GapType[] = ['covered', 'path-incomplete', 'untested']

function CoverageHeader({ ledger, gapFilter, onToggleGap }: { ledger: CoverageLedger; gapFilter: GapType | null; onToggleGap: (g: GapType) => void }) {
  const { total, untested } = ledger.totals
  const covered = countFor(ledger, 'covered')
  const mapped = total - untested
  const orphans = ledger.orphanRequirementIds.length
  return (
    <div className="clcov-statbar shrink-0">
      <CoverageRing pct={ledger.coveragePct} />
      <div className="clcov-breakdown">
        {/* One proportional bar makes the nesting self-evident: covered ⊂ mapped ⊂ total. */}
        <div className="clcov-bar" data-testid="coverage-breakdown" role="img" aria-label={`${covered} covered, ${countFor(ledger, 'path-incomplete')} path-incomplete, ${untested} untested of ${total}`}>
          {total === 0
            ? <span className="clcov-bar-seg" style={{ flexGrow: 1, background: 'var(--border-default)' }} />
            : SEG_ORDER.map((g) => {
                const count = countFor(ledger, g)
                return count === 0 ? null : <span key={g} className="clcov-bar-seg" style={{ flexGrow: count, background: GAP_META[g].color }} />
              })}
        </div>
        {/* Legend = filter. Clicking a class isolates those requirements. */}
        <div className="clcov-legend">
          {SEG_ORDER.map((g) => {
            const count = countFor(ledger, g)
            const meta = GAP_META[g]
            const on = gapFilter === g
            return (
              <button
                key={g}
                type="button"
                className="clcov-legend-item"
                data-testid={`gap-badge-${g}`}
                aria-pressed={on}
                data-on={on ? 'true' : 'false'}
                data-empty={count === 0 ? 'true' : 'false'}
                onClick={() => onToggleGap(g)}
                style={{ ['--seg' as string]: meta.color }}
              >
                <span className="clcov-legend-dot" style={{ background: meta.color }} />
                {meta.label}
                <span className="clcov-legend-n">{count}</span>
              </button>
            )
          })}
          <CoverageGlossary />
        </div>
        {/* Plain-language ratios — the two headline numbers, side by side, so the
            "32 mapped but 27 covered" gap reads itself. */}
        <div className="clcov-cap">
          <span title="Requirements where every declared path has a mapped test"><strong>{covered}/{total}</strong> covered · {ledger.coveragePct}%</span>
          <span className="clcov-cap-sep" aria-hidden="true">·</span>
          <span data-testid="mapped-stat" title="Requirements with at least one test mapped to them"><strong>{mapped}/{total}</strong> mapped · {ledger.mappedPct}%</span>
          {orphans > 0 && (
            <span data-testid="orphan-note" className="clcov-stale" title={`These test tags point at requirements that no longer exist — re-map to clear:\n${ledger.orphanRequirementIds.join(', ')}`}>
              ⚠ {orphans} stale tag{orphans > 1 ? 's' : ''}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

// One-hover glossary so the vocabulary never needs to be asked about.
function CoverageGlossary() {
  return (
    <span className="clcov-info" tabIndex={0} role="note" aria-label="What these terms mean">
      <span aria-hidden="true" className="clcov-info-i">i</span>
      <span className="clcov-info-pop" role="tooltip">
        <span><strong style={{ color: GAP_META.covered.color }}>Covered</strong> — every path the requirement declares (happy/sad/edge) has a mapped test.</span>
        <span><strong style={{ color: GAP_META['path-incomplete'].color }}>Path-incomplete</strong> — a test exists, but some declared path has none.</span>
        <span><strong style={{ color: 'var(--text-secondary)' }}>Untested</strong> — no test maps to the requirement.</span>
        <span><strong>Mapped</strong> — has ≥1 test (covered + path-incomplete). Coverage is decoupled from test runs.</span>
      </span>
    </span>
  )
}

function countFor(ledger: CoverageLedger, g: GapType): number {
  switch (g) {
    case 'untested': return ledger.totals.untested
    case 'path-incomplete': return ledger.totals.pathIncomplete
    case 'covered': return ledger.totals.covered
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
    <div style={{ position: 'relative', width: 66, height: 66, flexShrink: 0 }} data-testid="coverage-ring" aria-label={`${pct}% covered`}>
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
        <span style={{ fontSize: 8, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-muted)', marginTop: 2 }}>covered</span>
      </div>
    </div>
  )
}

function RequirementCard({ rc, colors, active, focused, dimmed, onHover }: {
  rc: RequirementCoverage
  colors: string[]
  active: boolean
  focused: boolean
  dimmed: boolean
  onHover: (on: boolean) => void
}) {
  const meta = GAP_META[rc.gapType]
  const missing = rc.pathCoverage.filter((p) => !p.covered).map((p) => p.path)
  const { kind, happyPath, unhappyPath } = rc.requirement
  // Only offer expansion when the summary actually carried extra detail.
  const hasDetail = Boolean(happyPath || unhappyPath || kind)
  const [expanded, setExpanded] = useState(false)
  const toggle = () => { if (hasDetail) setExpanded((c) => !c) }
  return (
    <div
      className="clcov-card"
      data-testid={`req-${rc.requirement.id}`}
      data-active={active ? 'true' : 'false'}
      data-focus={focused ? 'true' : 'false'}
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
        transition: 'opacity 120ms, background 120ms, border-color 140ms, box-shadow 140ms',
      }}
    >
      <div
        className={hasDetail ? 'clcov-disclose flex items-center gap-2' : 'flex items-center gap-2'}
        style={{ marginBottom: 5 }}
        {...(hasDetail
          ? {
              role: 'button' as const,
              tabIndex: 0,
              'aria-expanded': expanded,
              'data-testid': `req-toggle-${rc.requirement.id}`,
              onClick: toggle,
              onKeyDown: (e: ReactKeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle() } },
            }
          : {})}
      >
        {hasDetail && <span aria-hidden="true" className="clcov-caret">{expanded ? '▾' : '▸'}</span>}
        <span style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 10.5, fontWeight: 600, color: 'var(--text-muted)', background: 'var(--bg-base)', border: '1px solid var(--border-default)', borderRadius: 5, padding: '1px 5px' }}>{rc.requirement.id}</span>
        <strong style={{ fontSize: 13, color: 'var(--text-primary)' }}>{rc.requirement.title}</strong>
        {rc.requirement.deprecated && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>(deprecated)</span>}
        <span data-testid={`gap-${rc.requirement.id}`} style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 10, fontWeight: 600, color: meta.color, background: `color-mix(in srgb, ${meta.color} 12%, transparent)`, border: `1px solid color-mix(in srgb, ${meta.color} 40%, transparent)`, borderRadius: 999, padding: '2px 8px' }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: meta.color }} />
          {meta.label}{rc.gapType === 'path-incomplete' && missing.length > 0 ? ` · ${missing.join('/')}` : ''}
        </span>
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.45 }}>{rc.requirement.text}</div>
      <div className="flex flex-wrap items-center gap-2" style={{ marginTop: 7 }}>
        {rc.pathCoverage.map((p) => (
          p.covered ? (
            <span key={p.path} data-testid={`path-${rc.requirement.id}-${p.path}`} title={`${p.path} path has a mapped test`} style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 9.5, letterSpacing: '0.02em', padding: '1px 7px', borderRadius: 5, background: 'color-mix(in srgb, rgb(52,211,153) 10%, transparent)', border: '1px solid color-mix(in srgb, rgb(52,211,153) 40%, var(--border-default))', color: 'rgb(52,211,153)' }}>
              {p.path} ✓
            </span>
          ) : (
            // No test for this path — the dashed/muted treatment carries that; the
            // word "no test" was redundant with the pill's "· {path}" gap note.
            <span key={p.path} data-testid={`path-${rc.requirement.id}-${p.path}`} title={`No test maps to the ${p.path} path`} style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 9.5, letterSpacing: '0.02em', padding: '1px 7px', borderRadius: 5, border: '1px dashed color-mix(in srgb, var(--text-muted) 55%, var(--border-default))', color: 'var(--text-muted)' }}>
              {p.path}
            </span>
          )
        ))}
      </div>
      {hasDetail && expanded && (
        <div className="clcov-reqdetail" data-testid={`req-detail-${rc.requirement.id}`}>
          {kind && (
            <span className="clcov-kind" data-kind={kind}>{kind === 'non-functional' ? 'Non-functional' : 'Functional'}</span>
          )}
          {happyPath && (
            <div className="clcov-path-block">
              <span className="clcov-path-label clcov-path-happy">Happy path</span>
              <p className="clcov-path-text">{happyPath}</p>
            </div>
          )}
          {unhappyPath && (
            <div className="clcov-path-block">
              <span className="clcov-path-label clcov-path-unhappy">Unhappy path</span>
              <p className="clcov-path-text">{unhappyPath}</p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// The test's strength chip + `@req-*` / `@path-*` tags carry the meaning — no
// decorative accent border, and no run-coupled "verified" dot (coverage is semantic).
// Click the header to disclose the actual test source (lazily fetched by the parent).
function TestCard({ test, testNumber, color, active, dimmed, onHover, onExpand, source, sourceLoading, sourceError, onOpenEditor, onReqClick }: {
  test: TestCoverage
  testNumber?: number
  color: string
  active: boolean
  dimmed: boolean
  onHover: (on: boolean) => void
  onExpand: () => void
  source: { body: string; absFile: string; line: number } | null
  sourceLoading: boolean
  sourceError: string | null
  onOpenEditor: (absFile: string, line?: number) => void
  onReqClick: (id: string) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const toggle = () => {
    setExpanded((cur) => {
      if (!cur) onExpand() // trigger the lazy source fetch on first open
      return !cur
    })
  }
  return (
    <div
      className="clcov-card"
      data-testid={`test-${test.name}`}
      data-active={active ? 'true' : 'false'}
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
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
      <div
        className="clcov-disclose flex items-center gap-2"
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        data-testid={`test-toggle-${test.name}`}
        onClick={toggle}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle() } }}
      >
        <span aria-hidden="true" className="clcov-caret">{expanded ? '▾' : '▸'}</span>
        <TestIdBadge n={testNumber} />
        <strong style={{ fontSize: 13, color: 'var(--text-primary)' }}>{stripLeadingTestOrdinal(test.name)}</strong>
        {test.file && (
          <span style={{ marginLeft: 'auto', fontFamily: 'var(--font-mono, monospace)', fontSize: 10, color: 'var(--text-muted)' }}>{test.file}{test.line ? `:${test.line}` : ''}</span>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-1.5" style={{ marginTop: 7 }}>
        {test.strength && (
          <span
            data-testid={`strength-${test.name}`}
            title={STRENGTH_META[test.strength].title}
            className="flex items-center gap-1"
            style={{ fontSize: 10, fontWeight: 600, color: STRENGTH_META[test.strength].color, background: `color-mix(in srgb, ${STRENGTH_META[test.strength].color} 14%, transparent)`, border: `1px solid color-mix(in srgb, ${STRENGTH_META[test.strength].color} 45%, transparent)`, borderRadius: 999, padding: '1px 8px' }}
          >
            <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: '50%', background: STRENGTH_META[test.strength].color }} />
            {STRENGTH_META[test.strength].label}
          </span>
        )}
        {test.requirements.length === 0 && (
          <span data-testid={`orphan-${test.name}`} style={{ fontSize: 10, fontWeight: 600, color: 'rgb(251, 191, 36)', background: 'color-mix(in srgb, rgb(251,191,36) 12%, transparent)', border: '1px solid color-mix(in srgb, rgb(251,191,36) 40%, transparent)', borderRadius: 999, padding: '1px 8px' }}>orphan — no covers tag</span>
        )}
        {test.requirements.map((id) => (
          <button
            key={id}
            type="button"
            className="clcov-reqtag"
            data-testid={`reqtag-${test.name}-${id}`}
            title={`Jump to ${id}`}
            onClick={(e) => { e.stopPropagation(); onReqClick(id) }}
            style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 10, padding: '1px 6px', borderRadius: 5, background: `color-mix(in srgb, ${color} 14%, transparent)`, border: `1px solid color-mix(in srgb, ${color} 55%, transparent)`, color: 'var(--text-primary)' }}
          >@req-{id}</button>
        ))}
        {test.pathTypes.map((p) => (
          <span key={p} style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 10, padding: '1px 6px', borderRadius: 5, border: '1px solid var(--border-default)', color: 'var(--text-muted)' }}>@path-{p}</span>
        ))}
      </div>
      {expanded && (
        <div className="clcov-source" data-testid={`test-source-${test.name}`}>
          {source ? (
            <>
              <div className="clcov-source-head">
                <span className="clcov-source-path">{test.file}{test.line ? `:${test.line}` : ''}</span>
                <button
                  type="button"
                  className="clcov-source-open"
                  data-testid={`test-open-editor-${test.name}`}
                  onClick={() => onOpenEditor(source.absFile, source.line)}
                >
                  Open in editor ↗
                </button>
              </div>
              {/* Same syntax-highlighted code block as the run/playback view
                  (ShikiCode), but static: no activeLine / runningHighlight, so it
                  never shows a "currently running" line — coverage isn't a run. */}
              <ShikiCode source={source.body} />
            </>
          ) : sourceLoading ? (
            <div className="clcov-source-note">Loading source…</div>
          ) : sourceError ? (
            <div className="clcov-source-note">Couldn’t load source: {sourceError}</div>
          ) : (
            <div className="clcov-source-note">Source not found for this test.</div>
          )}
        </div>
      )}
    </div>
  )
}

// Placeholder card shown in the Tests pane while a coverage job runs. Same shell as
// TestCard (so it resolves into the real card in place), but every meaningful bit —
// dot, id badge, name, file, mapping chips — is a skeleton: the pane is honestly
// loading, not half-revealing the test set against the middle pane's "Mapping…".
// Widths vary per index so the column reads as a list of real cards, not a grid.
const SKEL_NAME_W = [172, 132, 198, 150, 116, 184, 142, 164]
function TestCardSkeleton({ index }: { index: number }) {
  return (
    <div
      className="clcov-card"
      data-testid="test-skeleton"
      aria-hidden="true"
      style={{
        marginBottom: 8,
        padding: '11px 13px',
        borderRadius: 'var(--radius-md)',
        background: 'var(--bg-surface)',
        border: '1px solid var(--border-default)',
      }}
    >
      <div className="flex items-center gap-2">
        <span className="clcov-skel" style={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0 }} />
        <span className="clcov-skel" style={{ width: 22, height: 16, borderRadius: 5 }} />
        <span className="clcov-skel" style={{ width: SKEL_NAME_W[index % SKEL_NAME_W.length], height: 13 }} />
        <span className="clcov-skel" style={{ marginLeft: 'auto', width: 84, height: 10 }} />
      </div>
      <div className="flex items-center gap-1.5" style={{ marginTop: 7 }}>
        <span className="clcov-skel" style={{ width: 56, height: 15 }} />
        <span className="clcov-skel" style={{ width: 42, height: 15 }} />
        <span className="clcov-skel" style={{ width: 68, height: 15 }} />
      </div>
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
/* Coverage breakdown: a proportional bar + legend-filter + plain-language ratios.
   Makes covered ⊂ mapped ⊂ total legible at a glance — no question needed. */
.clcov-breakdown{flex:1;min-width:0;display:flex;flex-direction:column;gap:8px;max-width:560px}
.clcov-bar{display:flex;height:9px;border-radius:999px;overflow:hidden;background:var(--bg-base);border:1px solid var(--border-default)}
.clcov-bar-seg{height:100%;min-width:3px;transition:flex-grow .35s ease}
.clcov-bar-seg+.clcov-bar-seg{box-shadow:-1px 0 0 color-mix(in srgb,var(--bg-base) 70%,transparent)}
.clcov-legend{display:flex;flex-wrap:wrap;align-items:center;gap:4px}
.clcov-legend-item{display:inline-flex;align-items:center;gap:6px;appearance:none;cursor:pointer;font-size:11.5px;color:var(--text-secondary);background:transparent;border:1px solid transparent;border-radius:7px;padding:3px 8px;transition:background .14s,color .14s,border-color .14s,opacity .14s}
.clcov-legend-item:hover{color:var(--text-primary);background:var(--bg-surface)}
.clcov-legend-item[data-empty='true']{opacity:.4}
.clcov-legend-item[data-on='true']{color:var(--text-primary);background:color-mix(in srgb,var(--seg) 15%,var(--bg-surface));border-color:color-mix(in srgb,var(--seg) 50%,transparent)}
.clcov-legend-dot{width:9px;height:9px;border-radius:3px;flex:none}
.clcov-legend-n{font-variant-numeric:tabular-nums;font-weight:700;color:var(--text-primary)}
.clcov-cap{display:flex;flex-wrap:wrap;align-items:center;gap:9px;font-size:11px;color:var(--text-muted)}
.clcov-cap strong{color:var(--text-secondary);font-variant-numeric:tabular-nums;font-weight:700}
.clcov-cap-sep{color:var(--border-default)}
.clcov-stale{color:rgb(251,191,36);cursor:help;border-bottom:1px dotted color-mix(in srgb,rgb(251,191,36) 55%,transparent)}
.clcov-info{position:relative;display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;margin-left:2px;border-radius:50%;border:1px solid var(--border-default);color:var(--text-muted);cursor:help;outline:none}
.clcov-info:hover,.clcov-info:focus-visible{color:var(--text-primary);border-color:color-mix(in srgb,var(--text-muted) 45%,var(--border-default))}
.clcov-info-i{font-size:10px;font-weight:700;font-style:italic;font-family:Georgia,serif;line-height:1}
.clcov-info-pop{position:absolute;top:calc(100% + 8px);left:0;z-index:10;width:330px;display:flex;flex-direction:column;gap:6px;padding:12px 13px;border-radius:var(--radius-md);background:var(--bg-surface);border:1px solid var(--border-default);box-shadow:var(--shadow-lg,0 8px 28px rgba(0,0,0,.4));font-size:11.5px;line-height:1.5;color:var(--text-secondary);opacity:0;visibility:hidden;transform:translateY(-3px);transition:opacity .14s,transform .14s,visibility .14s}
.clcov-info:hover .clcov-info-pop,.clcov-info:focus-within .clcov-info-pop,.clcov-info:focus-visible .clcov-info-pop{opacity:1;visibility:visible;transform:translateY(0)}
.clcov-card:hover{border-color:color-mix(in srgb,var(--text-muted) 38%,var(--border-default))}
/* A @req tag jumped-to from a test card: a brief accent ring locates the card. */
.clcov-card[data-focus='true']{box-shadow:0 0 0 2px color-mix(in srgb,var(--accent,rgb(56,189,248)) 70%,transparent)}
/* Clickable @req tags on a test card — jump to the matching requirement. */
.clcov-reqtag{appearance:none;cursor:pointer;transition:transform .1s,filter .12s}
.clcov-reqtag:hover{transform:translateY(-1px);filter:brightness(1.18)}
.clcov-reqtag:focus-visible{outline:none;box-shadow:0 0 0 2px color-mix(in srgb,var(--accent,rgb(56,189,248)) 55%,transparent)}
.cl-pulse{animation:clcov-pulse 1.4s ease-in-out infinite}
@keyframes clcov-pulse{0%,100%{opacity:1}50%{opacity:.4}}
.clcov-skel{display:inline-block;border-radius:5px;background:color-mix(in srgb,var(--text-muted) 16%,var(--bg-base));position:relative;overflow:hidden}
.clcov-skel::after{content:'';position:absolute;inset:0;transform:translateX(-100%);background:linear-gradient(90deg,transparent,color-mix(in srgb,var(--text-muted) 22%,transparent),transparent);animation:clcov-skel-sweep 1.3s ease-in-out infinite}
@keyframes clcov-skel-sweep{100%{transform:translateX(100%)}}
@media (prefers-reduced-motion:reduce){.cl-pulse{animation:none}.clcov-skel::after{animation:none}}
/* Click-to-expand cards: a quiet caret leads the header; the row is the hit target. */
.clcov-disclose{cursor:pointer;outline:none;border-radius:6px;margin:-2px -4px;padding:2px 4px;transition:background .12s}
.clcov-disclose:hover{background:color-mix(in srgb,var(--text-muted) 9%,transparent)}
.clcov-disclose:focus-visible{box-shadow:0 0 0 2px color-mix(in srgb,var(--accent,rgb(56,189,248)) 60%,transparent)}
.clcov-caret{flex:none;width:10px;font-size:10px;line-height:1;color:var(--text-muted)}
/* Test source disclosure. */
.clcov-source{margin-top:9px;border-top:1px solid var(--border-default);padding-top:9px}
.clcov-source-head{display:flex;align-items:center;gap:8px;margin-bottom:6px}
.clcov-source-path{font-family:var(--font-mono,monospace);font-size:10px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.clcov-source-open{margin-left:auto;flex:none;appearance:none;cursor:pointer;font-size:10px;font-weight:600;color:var(--text-secondary);background:var(--bg-base);border:1px solid var(--border-default);border-radius:6px;padding:2px 8px;transition:background .12s,color .12s,border-color .12s}
.clcov-source-open:hover{color:var(--text-primary);background:var(--bg-selected);border-color:color-mix(in srgb,var(--text-muted) 45%,var(--border-default))}
/* The shared ShikiCode block frames itself (.shiki-block pre); just cap its height so a long body scrolls in place. */
.clcov-source .shiki-block pre{max-height:360px;overflow:auto}
.clcov-source-note{font-size:11.5px;color:var(--text-muted);font-style:italic}
/* Requirement detail disclosure: kind chip + happy / unhappy paths. */
.clcov-reqdetail{margin-top:9px;border-top:1px solid var(--border-default);padding-top:9px;display:flex;flex-direction:column;gap:8px}
.clcov-kind{align-self:flex-start;font-size:9.5px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--text-muted);background:var(--bg-base);border:1px solid var(--border-default);border-radius:999px;padding:2px 9px}
.clcov-path-block{display:flex;flex-direction:column;gap:3px}
.clcov-path-label{align-self:flex-start;font-size:9.5px;font-weight:700;letter-spacing:.05em;text-transform:uppercase}
.clcov-path-happy{color:rgb(52,211,153)}
.clcov-path-unhappy{color:rgb(56,189,248)}
.clcov-path-text{margin:0;font-size:12px;line-height:1.5;color:var(--text-secondary)}
`
