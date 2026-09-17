import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as api from '@/shared/api/client'
import type { CoverageJobIndexEntry, CoverageJobKind, CoverageLedger, FeatureTests, GapType, TestCoverage, TestStrength } from '@/shared/api/types'
import type { AgentModelsConfig, AgentStagePlans, FlightStageKey, FlightStageStatus, ModelAgentKind, ModelStageKey } from '@/shared/api/client'
import { EMPTY_AGENT_MODELS } from '@shared/agent-models'
import { ModelLaunchGate } from '@/features/config'
import { StageStatusChip, stageLabel } from '@/features/flights/components/stage-meta'
import { CoverageDocsRail } from './CoverageDocsRail'
import { buildTestNumbering, testNumberKey } from '@/shared/test-numbering'
import { useInvalidationKey } from '@/shared/state/invalidation'
import { Hovered, RequirementCard, TestCard, TestCardSkeleton, compareRequirements } from './CoverageCards'
import { CoverageEmptyMain, CoverageHeader, HeadlinePill, readRailPref, writeRailPref } from './CoverageHeader'
import { COVERAGE_CSS } from './coverage-ledger-css'
import { coverageTestSources, type CoverageTestSource } from './coverage-test-sources'
import { useLiveCoverage } from '@/shared/state/use-live-coverage'
import type { CoverageRecoveryStage } from '@shared/coverage/freshness'

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
  onOpenRecovery?: (stage: CoverageRecoveryStage) => void
  onOpenGeneration: (job: CoverageJobIndexEntry) => void
  coverageJobs?: CoverageJobIndexEntry[]
}

export function CoverageLedgerPage({ feature, onClose, generatingFlight = null, onOpenFlight, onOpenRecovery, onOpenGeneration, coverageJobs = [] }: Props) {
  // Documents and results refresh when either an agent or another view writes
  // coverage evidence. Execution stays on Flight.
  const coverageRefreshKey = useInvalidationKey('coverage')
  const testsRefreshKey = useInvalidationKey('tests')
  const jobsKey = coverageJobs.filter((job) => job.feature === feature).map((job) => `${job.jobId}:${job.status}`).join('|')
  const { value: ledger, loading, error, confirmed, refresh } = useLiveCoverage(feature, jobsKey)
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

  // Flight owns execution and its live jobs. The ledger only launches work
  // and displays the documents/results when the user returns.
  const [launching, setLaunching] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [docsReloadKey, setDocsReloadKey] = useState(0)
  const activeJob = coverageJobs.find((job) => job.feature === feature && job.status === 'running')

  const toggleRail = useCallback(() => setRailOpen((v) => { writeRailPref(!v); return !v }), [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => () => {
    if (focusClearRef.current) clearTimeout(focusClearRef.current)
  }, [])

  // The models gate (2.2.0): Generate parks on "use defaults or customize?"
  // when the workspace armed askModelsOnLaunch. Holds the parked kind plus the
  // config snapshot the gate previews (fetched at click time, not page load).
  const [modelsGate, setModelsGate] = useState<{ kind: CoverageJobKind; agent: ModelAgentKind; agentModels: AgentModelsConfig } | null>(null)

  const beginJob = useCallback((kind: CoverageJobKind, launch?: { agent: ModelAgentKind; models: AgentStagePlans }) => {
    setActionError(null)
    setLaunching(true)
    // A customized launch pins `adapter` to the agent the gate showed, so the
    // server resolves the override for the same agent's vocabulary.
    api.startCoverageJob(feature, kind, launch ? { adapter: launch.agent, models: launch.models } : undefined)
      .then(onOpenGeneration)
      .catch(async (e: unknown) => {
        // A 409 means a job is already running (e.g. started from another tab/
        // session) — ATTACH to it instead of surfacing a raw error (R20).
        if (e instanceof api.ApiError && e.status === 409) {
          const existing = (e.body as { existingJobId?: string } | null)?.existingJobId
          if (existing) { onOpenGeneration(await api.getCoverageJob(existing)); return }
        }
        setActionError(e instanceof Error ? e.message : String(e))
      })
      .catch((e: unknown) => setActionError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLaunching(false))
  }, [feature, onOpenGeneration])

  const startJob = useCallback((kind: CoverageJobKind) => {
    if (launching) return
    setLaunching(true)
    setActionError(null)
    // Config unreachable → generate with defaults rather than dead-ending the
    // button on a settings probe (the gate is best-effort, launching is not).
    api.getProjectConfig()
      .then((config) => {
        if (config.askModelsOnLaunch === true) {
          setLaunching(false)
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
  }, [beginJob, launching])

  // Refresh results on workspace events and on authoritative job transitions.
  // The shared jobs read reconciles missed completion events without leaving a
  // second lifecycle or poller in the ledger.
  const coverageKeyMounted = useRef(false)
  useEffect(() => {
    if (!coverageKeyMounted.current) { coverageKeyMounted.current = true; return }
    setDocsReloadKey((k) => k + 1)
  }, [coverageRefreshKey, jobsKey, ledger?.freshness?.revision])

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
  const [specSourceRequested, setSpecSourceRequested] = useState(false)
  const ensureSpecSource = useCallback(() => setSpecSourceRequested(true), [])
  useEffect(() => {
    if (!specSourceRequested) return
    let cancelled = false
    setSpecSource(null)
    setSpecSourceLoading(true)
    setSpecSourceError(null)
    api.getFeatureTests(feature)
      .then((result) => { if (!cancelled) setSpecSource(result) })
      .catch((error: unknown) => {
        if (!cancelled) setSpecSourceError(error instanceof Error ? error.message : 'Failed to load test source')
      })
      .finally(() => { if (!cancelled) setSpecSourceLoading(false) })
    return () => { cancelled = true }
  }, [feature, specSourceRequested, testsRefreshKey, coverageRefreshKey, ledger?.freshness?.revision])

  // Generated titles need discovery before expansion; literal titles keep the
  // existing lazy source load. Never substitute a guessed loop value.
  useEffect(() => {
    if (ledger?.tests.some((test) => test.name.includes('${'))) ensureSpecSource()
  }, [ledger, ensureSpecSource])

  const testRows = useMemo(() => (ledger?.tests ?? []).flatMap<{ test: TestCoverage; source: CoverageTestSource | null }>((test) => {
    const sources = coverageTestSources(specSource ?? [], test)
    return sources.length
      ? sources.map((source) => ({ test, source }))
      : [{ test, source: null }]
  }), [ledger, specSource])

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
    // Worst-first: weakened tests → uncovered → partial → covered → the time axis.
    return [...filtered].sort(compareRequirements)
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

  const generating = launching || Boolean(activeJob) || Boolean(generatingFlight)

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
          {(specSourceError || specSource?.some((spec) => spec.discoveryError)) && (
            <div className="clcov-source-note" role="status">
              Couldn’t load discovered cases. Showing source definitions; generated titles may be unresolved.
              {specSourceError && ` ${specSourceError}`}
            </div>
          )}
          {orphanTests.length > 0 && (
            <div data-testid="orphan-tests-note" className="cl-aside clcov-note">
              <span className="clcov-alert" aria-hidden="true" style={{ background: 'var(--warning)', marginLeft: 0 }} />
              {orphanTests.length} orphan test{orphanTests.length > 1 ? 's' : ''} · no requirement tag — regenerate coverage to map them
            </div>
          )}
          {/* The strength summary/filter moved up to the stat header (above the
              tests column), mirroring the gap legend above the requirements column. */}
          {(strengthFilter ? testRows.filter(({ test }) => (test.strength ?? 'shallow') === strengthFilter) : testRows).map(({ test: t, source }) => (
            <TestCard
              key={`${t.name}:${source?.test.name ?? t.name}`}
              test={t}
              testNumber={testNumbering.get(testNumberKey(t.file, t.line))}
              active={activeTestNames.has(t.name)}
              dimmed={Boolean(hovered) && !activeTestNames.has(t.name)}
              onHover={(on) => setHovered(on ? { kind: 'test', key: t.name } : null)}
              onExpand={ensureSpecSource}
              source={source}
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
          <span className="cl-rubric">Semantic Coverage</span>
          <span className="clcov-feature">{feature}</span>
        </div>
        {state && <HeadlinePill headline={confirmed ? state.headline : 'Freshness unconfirmed'} />}
        <button type="button" onClick={onClose} className="clcov-close ml-auto" aria-label="Close coverage">
          Close <span aria-hidden="true">✕</span>
        </button>
      </header>

      {/* Execution stays on Flight; the ledger remains a results surface. */}
      {generatingFlight && !activeJob && (
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

      {activeJob && (
        <div data-testid="coverage-job-running" className="flex shrink-0 items-center gap-2.5 border-b border-line px-5 py-2">
          <StageStatusChip status="running" />
          <span className="text-[12px] text-secondary">Generation is running in Flight.</span>
          <button type="button" className="cl-button ml-auto" onClick={() => onOpenGeneration(activeJob)}>
            Open flight →
          </button>
        </div>
      )}

      {loading && !ledger && <div className="p-6" style={{ color: 'var(--text-secondary)' }}>Loading coverage…</div>}
      {error && <div className="p-6" style={{ color: 'var(--danger)' }}>Failed to load coverage: {error}</div>}

      {/* Unified view (R22): Docs rail + main, always one screen. The rail is
          ALWAYS present (even while generating, with destructive actions disabled);
          only the main area changes by state — no tabs, nothing unmounts. */}
      {ledger && (
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
            recovery={onOpenRecovery && ledger.freshness?.nextAction && ledger.freshness.nextAction.stage !== 'run' ? {
              onClick: () => onOpenRecovery(ledger.freshness!.nextAction!.stage),
              disabledReason: !confirmed ? 'Checking coverage freshness before starting work.'
                : generating ? 'Coverage work is already active. Open its Flight to follow progress.' : undefined,
            } : undefined}
          />
          <div className="flex min-h-0 flex-1 flex-col">
            {actionError && (
              <div data-testid="coverage-action-error" className="shrink-0 border-b px-5 py-2" style={{ borderColor: 'var(--border-default)', fontSize: 12, color: 'var(--danger)' }}>
                {actionError}
              </div>
            )}
            {summaryAbsent ? (
              <CoverageEmptyMain railOpen={railOpen} onOpenRail={toggleRail} />
            ) : (
              <>
                <CoverageHeader
                  ledger={ledger}
                  confirmed={confirmed}
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
