import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as api from '@/shared/api/client'
import type { CoverageJobKind, CoverageJobManifest, CoverageLedger, ExtractedTest, FeatureTests, GapType, TestCoverage, TestStrength } from '@/shared/api/types'
import type { AgentModelsConfig, AgentStagePlans, FlightStageKey, FlightStageStatus, ModelAgentKind, ModelStageKey } from '@/shared/api/client'
import { EMPTY_AGENT_MODELS } from '@shared/agent-models'
import { ModelLaunchGate } from '@/features/config'
import { StageStatusChip, stageLabel } from '@/features/flights/components/stage-meta'
import { CoverageDocsRail } from './CoverageDocsRail'
import { CoverageGeneratingPane } from './CoverageGeneratingPane'
import { buildTestNumbering, testNumberKey } from '@/shared/test-numbering'
import { useInvalidationKey } from '@/shared/state/invalidation'
import { Hovered, RequirementCard, STATUS_RANK, TestCard, TestCardSkeleton, statusOf, testColor } from './CoverageCards'
import { CoverageEmptyMain, CoverageHeader, HeadlinePill, readRailPref, writeRailPref } from './CoverageHeader'
import { COVERAGE_CSS } from './coverage-ledger-css'

// The two stages a coverage generation spawns (the summary job chains the
// mapping engine) — the models gate scopes its rows to them.
const COVERAGE_MODEL_STAGES: readonly ModelStageKey[] = ['prd', 'mapping']

interface Props {
  feature: string
  onClose: () => void
  // R14 (canary-first-flight): a flight's docs/prd-summary/specs-coverage stage
  // is generating THIS ledger right now (derived in App from the WS-driven
  // flights index) — render it as an explicit generating state, never a
  // silently empty page. Flight stages bypass the coverage-job store, so the
  // `job` takeover below can't know about them.
  generatingFlight?: { flightId: string; stage: FlightStageKey; stageStatus: FlightStageStatus } | null
  onOpenFlight?: (flightId: string) => void
}

export function CoverageLedgerPage({ feature, onClose, generatingFlight = null, onOpenFlight }: Props) {
  // Re-attach to a coverage job that started after the ledger opened (an
  // external agent mapping coverage) without a manual refresh — bumps on every
  // `coverage-changed` workspace event (cl_ws-driven-state).
  const coverageRefreshKey = useInvalidationKey('coverage')
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
  // Mirror of `job` for effect closures that must read the latest value WITHOUT
  // re-running on every poll tick (the re-attach effect below uses it to avoid
  // double-polling a job it's already following).
  const jobRef = useRef<CoverageJobManifest | null>(null)
  useEffect(() => { jobRef.current = job }, [job])
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

  // The models gate (2.2.0): Generate parks on "use defaults or customize?"
  // when the workspace armed askModelsOnLaunch. Holds the parked kind plus the
  // config snapshot the gate previews (fetched at click time, not page load).
  const [modelsGate, setModelsGate] = useState<{ kind: CoverageJobKind; agent: ModelAgentKind; agentModels: AgentModelsConfig } | null>(null)

  const beginJob = useCallback((kind: CoverageJobKind, launch?: { agent: ModelAgentKind; models: AgentStagePlans }) => {
    setActionError(null)
    // A customized launch pins `adapter` to the agent the gate showed, so the
    // server resolves the override for the same agent's vocabulary.
    api.startCoverageJob(feature, kind, launch ? { adapter: launch.agent, models: launch.models } : undefined)
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

  const startJob = useCallback((kind: CoverageJobKind) => {
    setActionError(null)
    // Config unreachable → generate with defaults rather than dead-ending the
    // button on a settings probe (the gate is best-effort, launching is not).
    api.getProjectConfig()
      .then((config) => {
        if (config.askModelsOnLaunch === true) {
          setModelsGate({
            kind,
            agent: config.healAgent === 'codex' ? 'codex' : 'claude',
            agentModels: config.agentModels ?? EMPTY_AGENT_MODELS,
          })
          return
        }
        beginJob(kind)
      })
      .catch(() => beginJob(kind))
  }, [beginJob])

  // R18: a generation job is durable server-side, so on mount (incl. after a
  // refresh) re-attach to the newest running job and resume the Generating
  // screen + chain-following. The in-memory flag alone lost this on reload.
  //
  // Also re-runs on every `coverage-changed` event (via coverageRefreshKey): if a
  // job STARTS after the ledger is already open — e.g. an external agent is
  // summoned to map coverage — this picks it up and flips to the Generating
  // screen live, no refresh (cl_ws-driven-state). The jobRef guard makes the
  // re-run a no-op when we're already following a job, so the running poll isn't
  // duplicated and the completion bump doesn't re-attach a finished job.
  useEffect(() => {
    let cancelled = false
    api.listCoverageJobs(feature)
      .then((jobs) => {
        if (cancelled || jobRef.current) return
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
  }, [feature, pollJob, coverageRefreshKey])

  // A non-job `coverage-changed` event (clear summary, doc add/delete via MCP or
  // another tab, external coverage map) bumps coverageRefreshKey. The job-attach
  // effect above only catches NEW jobs; here we re-pull the ledger AND re-list the
  // Docs rail so the open page reflects the change live — no manual refresh
  // (cl_ws-driven-state). Skip the initial mount (the refresh() effect already did
  // the first load).
  const coverageKeyMounted = useRef(false)
  useEffect(() => {
    if (!coverageKeyMounted.current) { coverageKeyMounted.current = true; return }
    refresh()
    setDocsReloadKey((k) => k + 1)
  }, [coverageRefreshKey, refresh])

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
    const byLoc = new Map<string, { test: ExtractedTest; absFile: string }>()
    const byName = new Map<string, { test: ExtractedTest; absFile: string }>()
    for (const sf of specSource ?? []) {
      for (const t of sf.tests) {
        const absFile = t.sourceFile ?? sf.file
        const entry = { test: t, absFile }
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
          <div data-testid="tests-remapping-note" style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 10, fontSize: 11, color: 'var(--running)' }}>
            <span className="cl-pulse" aria-hidden="true" style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--running)' }} />
            Mapping coverage to your tests…
          </div>
          {(ledger.tests.length > 0 ? ledger.tests : [null, null, null]).map((_, i) => (
            <TestCardSkeleton key={i} index={i} />
          ))}
        </>
      ) : (
        <>
          {ledger.tests.length === 0 && (
            <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>No tests found in this suite&apos;s specs.</div>
          )}
          {orphanTests.length > 0 && (
            <div data-testid="orphan-tests-note" style={{ marginBottom: 10, fontSize: 11, color: 'var(--warning)' }}>
              {orphanTests.length} orphan test{orphanTests.length > 1 ? 's' : ''} (no requirement) — regenerate coverage to map them.
            </div>
          )}
          {/* The strength summary/filter moved up to the stat header (above the
              tests column), mirroring the gap legend above the requirements column. */}
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
      {modelsGate && (
        <ModelLaunchGate
          launchNoun="coverage generation"
          agent={modelsGate.agent}
          stages={COVERAGE_MODEL_STAGES}
          config={modelsGate.agentModels}
          onCancel={() => setModelsGate(null)}
          onConfirm={(models) => {
            const gate = modelsGate
            setModelsGate(null)
            beginJob(gate.kind, models ? { agent: gate.agent, models } : undefined)
          }}
          confirmLabel="Generate"
        />
      )}
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

      {/* R14: a flight (not a coverage job) is generating this ledger — say so
          with the shared stage-status treatment instead of sitting silently
          empty. The coverage-job takeover keeps priority when it owns the view. */}
      {generatingFlight && !job && (
        <div data-testid="coverage-flight-generating" className="flex shrink-0 items-center gap-2.5 border-b px-5 py-2" style={{ borderColor: 'var(--border-default)' }}>
          <StageStatusChip status={generatingFlight.stageStatus} />
          <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
            {generatingFlight.stageStatus === 'waiting-for-approval'
              ? `Flight paused at ${stageLabel(generatingFlight.stage)} — a checkpoint needs your answer.`
              : `A flight is generating this — ${stageLabel(generatingFlight.stage)} is running; the ledger fills in live.`}
          </span>
          {onOpenFlight && (
            <button
              type="button"
              data-testid="coverage-open-flight"
              onClick={() => onOpenFlight(generatingFlight.flightId)}
              className="cl-button ml-auto px-2 py-0.5 text-[11px]"
              style={{ color: 'var(--accent)' }}
            >
              Open flight →
            </button>
          )}
        </div>
      )}

      {loading && !ledger && <div className="p-6" style={{ color: 'var(--text-secondary)' }}>Loading coverage…</div>}
      {error && <div className="p-6" style={{ color: 'var(--danger)' }}>Failed to load coverage: {error}</div>}

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
              <div data-testid="coverage-action-error" className="shrink-0 border-b px-5 py-2" style={{ borderColor: 'var(--border-default)', fontSize: 12, color: 'var(--danger)' }}>
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
                <CoverageHeader
                  ledger={ledger}
                  gapFilter={gapFilter}
                  onToggleGap={(g) => setGapFilter((cur) => (cur === g ? null : g))}
                  strengthFilter={strengthFilter}
                  onToggleStrength={(s) => setStrengthFilter((cur) => (cur === s ? null : s))}
                />
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
