import { useCallback, useEffect, useRef, useState } from 'react'
import type { RunStatus } from '@shared/run-state'
import type { RunArrivalTab, RunLocation } from '@/shared/lib/workspace-view-state'
import { branchForService } from '../utils/run-detail-playback'
import { useRun } from '../state/RunsContext'
import { deriveRunViewModel } from '../utils/run-view-model'
import { RunStatusIndicator } from './RunStatusIndicator'
import { PaneTerminal } from './PaneTerminal'
import { EmptyState } from '@/shared/ui/EmptyState'
import { EMPTY_COPY, healNoTranscriptCopy, type EmptyCopy } from '@/shared/ui/empty-state-copy'
import { AgentSessionView } from '@/shared/ui/AgentSessionView'
import { ExternalHealPanel } from './ExternalHealPanel'
import { RunQueueBanner } from './RunQueueBanner'
import { TestReviewBanner } from './TestReviewBanner'
import { ManualHealBanner } from './ManualHealBanner'
import { RunLogsTab, RunOverviewTab, VerifyOverviewTab, repoServiceCount } from './RunOverviewTabs'
import { RunPane } from './RunPane'
import { ResultsFixesTab, type ResultsView } from './ResultsFixesTab'
import type { ResultsSelection, ServiceLogAnchor } from '../utils/results-fixes'
import { ServiceLogInspector } from './ServiceLogInspector'
import { useResultsFocus } from '../state/use-results-focus'
import { ServiceTabButton } from './RunServicePanels'
import { Tab } from '@/shared/ui/Tab'
import { BootFailureDialog } from './BootFailureDialog'
import { compilerErrors } from '@/shared/ui/BootEvidence'
import { isTerminalRunStatus } from './run-export-links'

type Tab = 'overview' | 'run-logs' | 'services' | 'agent' | 'results'

/** Why this run has no repair transcript. A run that passed never spawned an
 *  agent at all — saying so is the whole answer, where "no structured session
 *  log found" reads as a missing file the user should go hunting for. The three
 *  answers are three different `EmptyReason`s, which is why they can't collapse. */
export function healEmptyCopy(status: RunStatus, healCycles: number): EmptyCopy {
  if (healCycles === 0) return status === 'passed' ? EMPTY_COPY.healPassed : EMPTY_COPY.healNeverRan
  return healNoTranscriptCopy(healCycles)
}

export function RunDetailColumn({
  runId,
  onOpenPlaywrightSettings,
  focusTest,
  focusTestId,
  focusTestLocation,
  focusRequest,
  arriveTab,
  onOpenEvaluationReport,
  onOpenSpecReview,
  bootFailureOpen,
  onBootFailureOpenChange,
  location,
  onLocationChange,
}: {
  runId: string | null
  onOpenSpecReview?: (feature: string, runId: string) => void
  onOpenPlaywrightSettings?: (feature: string) => void
  /** Opens the routed Flight Report stage after an evaluation task starts. */
  onOpenEvaluationReport?: (feature: string) => void
  /** R82: a test to land on — the run-summary `name` of a failure clicked in a
   *  flight's Test Run stage, or of a result badge clicked in the Tests column.
   *  Opens Results & Fixes with that test's row expanded and scrolled into
   *  view. Routed as `?run=…&test=…`, so a refresh or a pasted link lands in
   *  the same place. */
  focusTest?: string
  focusTestId?: string
  focusTestLocation?: string
  /** Bumped by each click on a test, so the same test clicked again re-opens. */
  focusRequest?: number
  /** Which tab to open on, when the view that linked here named one instead of a
   *  failing test — the flight's Test Run stage sends its captured fixes to
   *  `changes`, which is Results & Fixes' run-wide view. Routed as
   *  `?run=…&runtab=…`, so a refresh lands the same way. */
  arriveTab?: RunArrivalTab
  /** The boot-failure detail dialog, routed as `?run=…&dialog=boot-failure`.
   *  Absent = the service card keeps the open state itself. */
  bootFailureOpen?: boolean
  onBootFailureOpenChange?: (open: boolean) => void
  /** A restored place inside this run (a cold load of `?run=…&runtab=…`). Read
   *  when the run opens; afterwards the reader's own state is the owner. */
  location?: RunLocation
  /** Reports where the reader is, so the route can restore it. Absent for
   *  embedded details (services dialog, benchmark), which stay unrouted. */
  onLocationChange?: (location: RunLocation) => void
}) {
  // Arriving with a focused failure means Results & Fixes IS the destination —
  // opening on Overview would hide the thing that was clicked. A named arrival
  // tab is the same contract for a link that points at a pane rather than a test.
  const [tab, setTab] = useState<Tab>(location ? location.tab ?? 'overview' : focusTest || arriveTab ? 'results' : 'overview')
  // By safe name, so a link names the same service whatever order it boots in.
  const [serviceKey, setServiceKey] = useState<string | null>(location?.service ?? null)
  const [resultsView, setResultsView] = useState<ResultsView>(location ? location.view ?? 'tests' : arriveTab === 'changes' && !focusTest ? 'run-wide' : 'tests')
  // A restored place applies once, to the run it was restored for: its case
  // and cycle when the routed test resolves, its tab instead of the one a
  // focused test would otherwise imply.
  const seed = useRef(location ? { runId, location, focusKey: JSON.stringify([focusTest, focusTestId, focusTestLocation, focusRequest]) } : null)
  // Owned here, not by the tab, so leaving Results & Fixes and coming back
  // (from a linked service log, say) keeps the reader's case and cycle.
  const [selection, setSelection] = useState<ResultsSelection>({ caseKey: null })
  // A Full service log link: the Services tab shows that retained range until
  // the reader asks for the latest output or picks another service.
  const [logAnchor, setLogAnchor] = useState<ServiceLogAnchor | null>(
    location?.service && location.log ? { service: location.service, ...location.log } : null,
  )
  const [agentPaneRestartKey, setAgentPaneRestartKey] = useState(0)
  const [agentPaneExited, setAgentPaneExited] = useState(false)
  const currentRunStatusRef = useRef<RunStatus | undefined>(undefined)
  const [ownBootFailureOpen, setOwnBootFailureOpen] = useState(false)
  const bootFailureDialogOpen = bootFailureOpen ?? ownBootFailureOpen
  const setBootFailureDialogOpen = onBootFailureOpenChange ?? setOwnBootFailureOpen

  // Detail comes from the WebSocket-backed RunsContext. No polling here —
  // the same `state.details[runId]` populated for the runs list is reused,
  // so the header badge flips status the instant the server pushes the
  // next `update` frame. The transient action (e.g. user clicked Stop in
  // the runs list) is overlaid into `displayStatus` so this header shows
  // `ABORTING` mid-action instead of stale `RUNNING`.
  const { detail, transient } = useRun(runId)
  const handleAgentPaneExit = useCallback(() => {
    if (currentRunStatusRef.current === 'healing') return
    setAgentPaneExited(true)
  }, [])

  useEffect(() => {
    setAgentPaneExited(false)
  }, [runId, agentPaneRestartKey])

  useEffect(() => {
    currentRunStatusRef.current = detail?.manifest.status
    if (detail?.manifest.status === 'healing') {
      setAgentPaneExited(false)
    }
  }, [detail?.manifest.status])

  // Each new heal cycle spawns a fresh Claude/Codex PTY. Without this, after
  // the previous cycle's PTY exited (and we flipped to the transcript view),
  // the transcript would keep showing for cycle 2+ even though a live PTY is
  // running — because `agentPaneExited` is sticky and `agentPaneRestartKey`
  // never changed. Bumping the restart key remounts PaneTerminal with a
  // fresh connection and (via the effect above) clears the exited flag.
  const lastHealCyclesRef = useRef<number | undefined>(undefined)
  useEffect(() => {
    const cycles = detail?.manifest.healCycles
    if (cycles == null) return
    if (lastHealCyclesRef.current !== undefined && cycles > lastHealCyclesRef.current) {
      setAgentPaneRestartKey((k) => k + 1)
    }
    lastHealCyclesRef.current = cycles
  }, [detail?.manifest.healCycles])

  const executionType = detail?.manifest.executionType ?? 'run'
  const isVerifyRun = executionType === 'verify'
  const isBootRun = executionType === 'boot'
  // Another run's selection must never show under this one.
  const seededRun = useRef(runId)
  useEffect(() => {
    if (seededRun.current === runId) return
    seededRun.current = runId
    seed.current = null
    setSelection({ caseKey: null })
    setLogAnchor(null)
    setServiceKey(null)
  }, [runId])
  const focusKey = JSON.stringify([focusTest, focusTestId, focusTestLocation, focusRequest])
  const seeding = seed.current?.runId === runId && seed.current.focusKey === focusKey ? seed.current.location : undefined
  // A later focus (clicking a second failure while this run is already open)
  // switches back to the tab that can show it. A restored place already says
  // which tab its test was read on.
  useEffect(() => {
    if (!focusTest || seeding) return
    setTab('results')
    setResultsView('tests')
  }, [focusTest, focusTestId, focusTestLocation, focusRequest, runId, seeding])
  const focusTarget = focusTest ? { name: focusTest, ...(focusTestId ? { id: focusTestId } : {}), ...(focusTestLocation ? { location: focusTestLocation } : {}) } : undefined
  // Which focus the selection has taken up, set in the same update as the
  // selection so the reported place never drops the test in between.
  const [appliedFocus, setAppliedFocus] = useState<string | null>(null)
  const focus = useResultsFocus(runId, detail, { test: focusTest, testId: focusTestId, testLocation: focusTestLocation, request: focusRequest }, (caseKey) => {
    seed.current = null
    setAppliedFocus(`${runId}:${focusKey}`)
    setSelection({
      caseKey,
      ...(focusTarget ? { test: focusTarget } : {}),
      ...(seeding?.cycle !== undefined ? { cycle: seeding.cycle } : {}),
      ...(seeding?.journal ? { journal: seeding.journal } : {}),
    })
  })
  // Same for a later arrival at a named tab (clicking the run's captured fixes
  // while that run is already open) — otherwise the click looks ignored.
  useEffect(() => {
    if (arriveTab !== 'changes') return
    setTab('results')
    setResultsView('run-wide')
  }, [arriveTab, runId])
  useEffect(() => {
    if (isVerifyRun && tab !== 'overview' && tab !== 'results') setTab('overview')
    // A boot-only session has no Playwright / heal / journal — keep the user on
    // the tabs that exist (overview, run logs, services).
    if (isBootRun && tab !== 'overview' && tab !== 'run-logs' && tab !== 'services') setTab('overview')
  }, [isVerifyRun, isBootRun, tab])

  // The reader's place, for the route. While a routed or clicked test has not
  // resolved yet (its events can arrive after the link), the URL keeps naming
  // it rather than dropping it.
  const pendingTest = appliedFocus === `${runId}:${focusKey}` ? undefined : focusTarget
  const selectedTest = selection.caseKey ? selection.test : pendingTest
  const routedLocation: RunLocation = {
    ...(tab !== 'overview' ? { tab } : {}),
    ...(tab === 'results' && resultsView !== 'tests' ? { view: resultsView } : {}),
    ...(selectedTest ? { test: selectedTest } : {}),
    ...(selectedTest && (selection.caseKey ? selection.cycle : seeding?.cycle) !== undefined ? { cycle: (selection.caseKey ? selection.cycle : seeding?.cycle)! } : {}),
    ...(selectedTest && (selection.caseKey ? selection.journal : seeding?.journal) ? { journal: (selection.caseKey ? selection.journal : seeding?.journal)! } : {}),
    ...(serviceKey ? { service: serviceKey } : {}),
    ...(tab === 'services' && logAnchor && logAnchor.service === serviceKey ? { log: { execution: logAnchor.execution, startLine: logAnchor.startLine, endLine: logAnchor.endLine, approximate: logAnchor.approximate } } : {}),
  }
  const routedKey = JSON.stringify(routedLocation)
  const report = useRef(onLocationChange)
  report.current = onLocationChange
  useEffect(() => {
    if (runId) report.current?.(JSON.parse(routedKey) as RunLocation)
  }, [runId, routedKey])

  // Compact for both: the run list that fills this pane sits directly above
  // it, so a three-line body here would spend all three saying "pick one".
  if (!runId) return <EmptyState compact reason="not-yet" title="No run selected" testId="run-detail-none" />
  if (!detail) return <EmptyState compact reason="not-yet" title="Loading this run…" testId="run-detail-loading" />

  const m = detail.manifest
  const isVerify = isVerifyRun
  const view = deriveRunViewModel(detail, transient)
  const services = m.services
  const repoBranches = m.repoBranches ?? []
  const requestedService = serviceKey === null ? -1 : services.findIndex((s) => s.safeName === serviceKey)
  const serviceIdx = Math.max(0, requestedService)
  const activeService = services[serviceIdx]
  // A link can outlive the service it named (a suite that no longer starts
  // it); say so rather than showing another service's log as if it were it.
  const staleService = serviceKey !== null && requestedService === -1 ? serviceKey : null
  const showAgentSession = isTerminalRunStatus(m.status) || agentPaneExited
  // External heal keeps its own panel: the parked/claimed state is the answer there.
  const settledWithoutRepair = isTerminalRunStatus(m.status) && m.healCycles === 0 && m.healMode !== 'external'
  // The dialog is the full compiler-error list, so only a card that shows such a
  // list can open it. A dependency blocker has its own panel and no dialog.
  const bootFailure = m.bootFailure?.reason !== 'dependency-incompatible' ? m.bootFailure : undefined
  const bootErrors = compilerErrors(bootFailure?.excerpt)

  return (
    <div className="cl-panel relative flex h-full flex-col">
      <header className="cl-panel-header px-4 pt-3 pb-0">
        <div className="flex min-w-0 items-center gap-2">
          <span className="shrink-0">
            <RunStatusIndicator status={view.displayStatus} executionType={executionType} waiting={view.waiting} />
          </span>
          <span
            className="min-w-0 flex-1 truncate text-sm font-medium"
            title={m.runId}
            style={{ color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}
          >
            {m.runId}
          </span>
          <span
            className="min-w-0 shrink truncate text-xs"
            title={m.feature}
            style={{ color: 'var(--text-muted)' }}
          >
            {m.feature}
          </span>
          <span
            className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase"
            style={{
              background: isVerify ? 'var(--accent-soft)' : isBootRun ? 'var(--boot-soft)' : 'var(--bg-selected)',
              color: isVerify ? 'var(--accent)' : isBootRun ? 'var(--boot)' : 'var(--text-muted)',
              letterSpacing: '0.04em',
            }}
          >
            {isVerify ? 'Verify' : isBootRun ? 'Boot' : 'Run'}
          </span>
        </div>
        {m.status === 'queued' && <RunQueueBanner key={m.runId} runId={m.runId} />}
        {view.waiting?.kind === 'test-review' && onOpenSpecReview && (
          <TestReviewBanner count={m.specEdits?.pending.length ?? 0} onReview={() => onOpenSpecReview(m.feature, m.runId)} />
        )}
        <nav className="mt-3 flex gap-5 overflow-x-auto scrollbar-none">
          <Tab active={tab === 'overview'} onClick={() => setTab('overview')} className="shrink-0 whitespace-nowrap">Overview</Tab>
          {!isVerify && <Tab active={tab === 'run-logs'} onClick={() => setTab('run-logs')} className="shrink-0 whitespace-nowrap">Run Logs</Tab>}
          {!isVerify && <Tab active={tab === 'services'} onClick={() => setTab('services')} disabled={services.length === 0} className="shrink-0 whitespace-nowrap">Services</Tab>}
          {!isVerify && !isBootRun && <Tab active={tab === 'agent'} onClick={() => setTab('agent')} className="shrink-0 whitespace-nowrap">Heal Agent</Tab>}
          {/* Every test's result and repair story, plus the run's own captured
              changes, journal and Playwright terminal. Always openable: a run
              that repaired nothing is a fact worth reading. */}
          {!isBootRun && <Tab active={tab === 'results'} onClick={() => setTab('results')} className="shrink-0 whitespace-nowrap">Results &amp; Fixes</Tab>}
        </nav>
      </header>
      <div className="flex-1 min-h-0 overflow-hidden mt-2">
        {tab === 'overview' && (
          isVerify ? (
            <VerifyOverviewTab manifest={m} view={view} onCompareTests={onOpenSpecReview ? () => onOpenSpecReview(m.feature, m.runId) : undefined} />
          ) : (
            <RunOverviewTab
              manifest={m}
              view={view}
              services={services}
              repoBranches={repoBranches}
              onCompareTests={onOpenSpecReview ? () => onOpenSpecReview(m.feature, m.runId) : undefined}
              onOpenEvaluationReport={onOpenEvaluationReport}
              onOpenBootFailure={() => setBootFailureDialogOpen(true)}
            />
          )
        )}
        {!isVerify && tab === 'run-logs' && (
          <RunLogsTab view={view} summary={detail.summary} runId={m.runId} runStatus={m.status} />
        )}
        {!isVerify && tab === 'services' && services.length > 0 && (
          <RunPane
            scroll={false}
            bar={
              <>
                {services.map((s, i) => (
                  <ServiceTabButton
                    key={s.safeName}
                    service={s}
                    branch={branchForService(s, repoBranches)}
                    active={i === serviceIdx}
                    onClick={() => { setServiceKey(s.safeName); setLogAnchor(null) }}
                    siblings={repoServiceCount(s, services)}
                  />
                ))}
              </>
            }
          >
            {staleService && activeService && (
              <p className="m-0 shrink-0 border-b px-3 py-2 text-[11px]" style={{ borderColor: 'var(--border-default)', color: 'var(--text-muted)' }} data-testid="stale-service-link">
                This link names a service this run did not start ({staleService}); showing {activeService.name}.
              </p>
            )}
            {activeService && logAnchor?.service === activeService.safeName ? (
              <ServiceLogInspector
                key={JSON.stringify(logAnchor)}
                runId={m.runId}
                anchor={logAnchor}
                serviceName={activeService.name}
                onBack={() => setTab('results')}
                onLatest={() => setLogAnchor(null)}
              />
            ) : activeService && (
              <PaneTerminal
                runId={m.runId}
                paneId={`service:${activeService.safeName}`}
                emptyState={{ idle: EMPTY_COPY.paneServiceIdle, missing: EMPTY_COPY.paneServiceMissing }}
              />
            )}
          </RunPane>
        )}
        {!isBootRun && tab === 'results' && (
          <ResultsFixesTab
            detail={detail}
            view={resultsView}
            onViewChange={setResultsView}
            selection={selection}
            onSelectionChange={setSelection}
            {...(focus === 'unmatched' && focusTest ? { unmatchedTest: focusTest } : {})}
            repairEvidence={!isVerify}
            diagnostics={m.verification?.diagnostics}
            onOpenServiceLog={(anchor) => {
              if (!services.some((s) => s.safeName === anchor.service)) return
              setServiceKey(anchor.service)
              setLogAnchor(anchor)
              setTab('services')
            }}
            {...(onOpenPlaywrightSettings ? { onOpenArtifactSettings: () => onOpenPlaywrightSettings(m.feature) } : {})}
          />
        )}
        {/* Always rendered, hidden via display:none when another tab is active.
            Keeps the live xterm + WebSocket alive so the Ink-based heal agent
            TUI isn't replayed from scratch on tab return — replaying the raw
            stream re-executes every clear-screen redraw and collapses scrollback
            to the last frame. */}
        {!isVerify && <div hidden={tab !== 'agent'} className="h-full min-h-0">
          {/* One flex column, not a banner beside a `h-full` block: the pane's
              wrapper clips at its own height, so a `h-full` agent view under a
              banner overflowed by exactly the banner's height and cut that much
              off the bottom of the transcript. */}
          {settledWithoutRepair ? (
            // A run that finished without one repair cycle has no transcript to
            // read: answer at once, in the same padded pane — surface, inset
            // and vertical position — as the Changes and Journal empty states,
            // instead of a session read that can only come back empty.
            <RunPane padded>
              <EmptyState testId="heal-empty" {...healEmptyCopy(m.status, m.healCycles)} />
            </RunPane>
          ) : (
          <RunPane scroll={false}>
            <div className="flex h-full min-h-0 flex-col overflow-hidden">
              {m.healMode === 'manual' && view.actions.cancelHeal.enabled && m.signalPaths && (
                <div className="shrink-0">
                  <ManualHealBanner runId={m.runId} signalPaths={m.signalPaths} />
                </div>
              )}
              <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
              {m.healMode === 'external' ? (
                // External heal: there is no local PTY to attach. The agent
                // transcript lives in the user's Claude / Codex window once a
                // client claims the run; before that, show the parked state.
                <ExternalHealPanel
                  runId={m.runId}
                  runStatus={m.status}
                  session={m.externalHealSession}
                />
              ) : showAgentSession ? (
                <AgentSessionView
                  source={{ kind: 'run', runId: m.runId, live: !isTerminalRunStatus(m.status) }}
                  empty={healEmptyCopy(m.status, m.healCycles)}
                />
              ) : (
                <PaneTerminal
                  key={`${m.runId}:agent:${agentPaneRestartKey}`}
                  runId={m.runId}
                  paneId="agent"
                  onExit={handleAgentPaneExit}
                  emptyState={{ idle: EMPTY_COPY.paneAgentIdle, missing: EMPTY_COPY.paneAgentMissing }}
                />
              )}
              </div>
            </div>
            {/* Retest lives as a per-row icon in RunsColumn now (see
                RetestIconButton). The footer-bar variant that used to sit here
                duplicated that affordance. */}
          </RunPane>
          )}
        </div>}
      </div>
      {/* Mounted here, not in the Overview tab, so switching tabs can't strand
          an open dialog's route. */}
      {bootFailure && bootErrors.length > 0 && (
        <BootFailureDialog
          open={bootFailureDialogOpen}
          onClose={() => setBootFailureDialogOpen(false)}
          failure={bootFailure}
          errors={bootErrors}
        />
      )}
    </div>
  )
}
