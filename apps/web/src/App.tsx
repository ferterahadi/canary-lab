import { useApprovals } from './shared/state/use-approvals'
import { Suspense, lazy, useCallback, useMemo, useState, type ReactNode } from 'react'
import { coverageGeneratingFlight as generatingFlightFor } from './features/flights/lib/workspace-flights'
import { useCoverageRecalculation } from './shared/state/use-coverage-recalculation'
import { FeaturesColumn } from './shared/shell/FeaturesColumn'
import { TestCasesColumn } from './shared/shell/TestCasesColumn'
import { RunsColumn } from './features/runs/components/RunsColumn'
import { DemoDialog } from './features/getting-started/components/DemoDialog'
import { useGettingStarted } from './features/getting-started/state/use-getting-started'
import { RunDetailColumn } from './features/runs/components/RunDetailColumn'
import { FeatureConfigEditor } from './features/config/components/FeatureConfigEditor'
import { ModelLaunchGate } from './features/config/components/ModelLaunchGate'
import { ResizablePanels, type PanelConfig } from './shared/ui/ResizablePanels'
import { VerticalSplit } from './shared/ui/VerticalSplit'
import { GlobalStatusBar } from './shared/shell/GlobalStatusBar'
import { WorkspaceRecordSyncStatus } from './shared/shell/WorkspaceRecordSyncStatus'
import { CollisionConfirmDialog } from './features/runs/components/CollisionConfirmDialog'
import { RunStartErrorDialog } from './features/runs/components/RunStartErrorDialog'
import { PendingRunStartNotice } from './features/runs/components/PendingRunStartNotice'
// The three routed full-screen views load lazily: none of them is needed for
// the workspace's first paint, and together (the flight detail tree above all)
// they were a large slice of the single main chunk every cold load downloaded.
const LogCleanupPage = lazy(() => import('./features/cleanup/components/LogCleanupPage').then((m) => ({ default: m.LogCleanupPage })))
const CoverageLedgerPage = lazy(() => import('./features/coverage/components/CoverageLedgerPage').then((m) => ({ default: m.CoverageLedgerPage })))
const FlightPage = lazy(() => import('./features/flights/components/FlightPage').then((m) => ({ default: m.FlightPage })))
import { FlightStartDialog } from './features/flights/components/FlightStartDialog'
import { runWaitingState } from './features/runs/utils/run-waiting-state'
import { useRuns, useGlobalActiveRun } from './features/runs/state/RunsContext'
import { useRunStart } from './features/runs/state/use-run-start'
import type { FlightsPillProps } from './features/flights/components/FlightsPill'
import { TERMINAL_RUN_STATUSES } from '@shared/run-state'
import {
  derivedFlightFeature,
  derivedFlightToken,
  latestTerminalRunByFeature,
} from './features/flights/lib/derived-stages'
import type { RepoOption } from './features/flights/components/RepoMultiPicker'
import { NotificationCenter } from './features/notifications/NotificationCenter'
import { useInvalidation } from './shared/state/invalidation'
import { useWorkspace } from './WorkspaceProvider'
import type { CoverageJobIndexEntry } from '@shared/coverage/types'
import type { TestChangeKind } from '@shared/test-review'
import type { TestReviewRequired } from './shared/api/runs'
import type { RunOpenTarget } from './shared/lib/workspace-view-state'
import type { ModelStageKey } from '@shared/agent-models'
import type { NotificationTarget } from '@shared/notifications/types'
import { plural } from '@shared/lib/plural'

// The two stages a suite run spawns — the models gate scopes its rows to them.
const RUN_MODEL_STAGES: readonly ModelStageKey[] = ['heal', 'commit']
const WORKSPACE_PANELS = [
  { id: 'features', minWidth: 180, defaultWidth: 220, collapsible: true, collapseButtonY: 'top' },
  { id: 'tests', minWidth: 280, defaultWidth: 360, collapsible: true, collapseButtonY: 'bottom' },
  { id: 'runs', minWidth: 400, defaultWidth: 500, collapsible: false },
] as const satisfies readonly PanelConfig[]

export function App() {
  const [specTotalTests, setSpecTotalTests] = useState(0)
  // The workspace's URL state, selection, suites and flights live in
  // WorkspaceProvider (mounted in main.tsx), which also fills the WorkState and
  // WorkspaceActions contexts the deeper leaves read. App lays the screen out
  // from it; the names below are the ones App always used.
  const workspace = useWorkspace()
  const { nav, invalidateCoverage, openFlightStage, openFeatureStage, openPortifyStage, openActivity } = workspace
  const {
    view, setView,
    selectedFeature, setSelectedFeature,
    selectedRunId, setSelectedRunId,
    selectedFlightId, setSelectedFlightId,
    configFor, setConfigFor, openConfig, configTab, setConfigTab,
    verifyOpen, setVerifyOpen,
    specReviewOpen, setSpecReviewOpen, reviewFocus, setReviewFocus, openReview,
    flightStartFor, flightStartFresh, flightStartStage, setFlightStartFor,
    flightStartNew, setFlightStartNew,
    demoOpen, setDemoOpen,
    settingsOpen, setSettingsOpen, modelsFor, setModelsFor,
    resumePlanTaskId, setResumePlanTaskId,
    focusTest, runTab, bootFailureFor, setBootFailureFor,
    openFlight, navigateToRun, navigateToCoverage, returnFlight, selectStartedRun,
    flightStage, setFlightStage, flightLog, setFlightLog,
  } = nav

  const { runs: allRuns, startRun: startRunAction, startVerification: startVerificationAction } = useRuns()
  // Each suite row's last-run dot. Derived from the same live index, so a run
  // settling anywhere (GUI, MCP, CLI) repaints the column without a refetch.
  const lastRuns = useMemo(() => latestTerminalRunByFeature(allRuns, TERMINAL_RUN_STATUSES), [allRuns])
  const { invalidate } = useInvalidation()

  const {
    featureRuns, selectedRunForFeature, statusRunDetail, selectedRunEvidence,
    selectFeature, selectFeatureForReview,
  } = workspace.selection
  const {
    features, flights, flightDetails, flightsHydrated, forgetFlight, flightsRef, versionStatus,
    refreshFeatures, refreshFlights,
  } = workspace.data

  const { entry: globalActiveRunEntry, detail: activeRunDetail } = useGlobalActiveRun()
  const activeRunWaiting = runWaitingState(activeRunDetail ?? globalActiveRunEntry)
  const {
    activity: featureActivity, coverageJobs, selectedFeatureActivity,
    flightAction, featuresWithPending, coverageGeneratingFlight,
  } = workspace.work
  // Stable identity on purpose: FeaturesColumn holds this in a fetch effect's
  // dep list, and a fresh arrow per render made it refetch every feature's
  // coverage on every render. The column guards against that too — this keeps
  // the prop honest at the source.
  // No origin flight: this is the user opening the ledger on their own, so any
  // way-back a previous drill-through left is cleared.
  const openCoverageFor = useCallback((feature: string): void => {
    navigateToCoverage(feature)
  }, [navigateToCoverage])

  const openRecalculation = useCallback((feature: string) => {
    setFlightStartFor(null)
    setFlightStartNew(false)
    const active = generatingFlightFor(flightsRef.current, feature)
    if (active) { setSelectedFeature(feature); openFlightStage(active.flightId, 'docs') }
    else openFeatureStage(feature, 'docs')
  }, [flightsRef, openFeatureStage, openFlightStage, setSelectedFeature, setFlightStartFor, setFlightStartNew])
  const recalculation = useCoverageRecalculation({
    jobs: coverageJobs, openRequirements: openRecalculation, invalidate: invalidateCoverage,
    hasActiveFlight: (feature) => generatingFlightFor(flightsRef.current, feature) !== null,
  })
  const flightRecalculation = recalculation.launch
    && (flights.find((entry) => entry.flightId === selectedFlightId)?.feature
      ?? (selectedFlightId ? derivedFlightFeature(selectedFlightId) : null)) === recalculation.launch.feature
    ? recalculation.launch : null

  // Evaluation exports are reviewed on Flight's Report stage. A suite need not
  // have a conductor record: standalone work uses the same evidence-derived
  // `feature:` Flight the picker and per-suite shortcuts already use.
  const openEvaluationReport = useCallback((feature: string): void => {
    openFeatureStage(feature, 'evaluation-export')
  }, [openFeatureStage])

  const { demo, openDemo, launchDemo, openTarget, actionBlockers } = useGettingStarted({
    allRuns, flights, setDemoOpen, setSelectedFeature, navigateToRun,
    navigateToCoverage, openFlight, openFlightStage, openFeatureStage,
  })

  // R83: what the return chip says. The origin is whatever `flight` held — a
  // recorded id (name it from the index) or a `feature:<name>` derived token
  // (the name IS the token). An id the index no longer carries still gets a
  // chip: the way back matters more than the label.
  const returnFlightLabel = useMemo(() => {
    if (!returnFlight) return null
    return flights.find((f) => f.flightId === returnFlight)?.feature
      ?? derivedFlightFeature(returnFlight)
  }, [returnFlight, flights])

  // The run-start flow (collision prompt, branch-mismatch recovery, silent-
  // failure guard) lives in useRunStart — App just wires selection + the dialogs.
  const {
    collisionPrompt, setCollisionPrompt,
    startError, setStartError,
    pendingStarts, dismissPendingStart,
    modelsPrompt, setModelsPrompt, resolveModelsPrompt,
    handleStartRun, resolveCollision, retryStartError, switchBranchesAndRun, pinCurrentAndRun,
    handleStartVerification,
  } = useRunStart({
    selectedFeature,
    startRun: startRunAction,
    startVerification: startVerificationAction,
    onRunStarted: selectStartedRun,
  })
  const openPendingReview = useCallback((feature: string, runId: string): void => {
    setStartError(null)
    navigateToRun(feature, runId)
    openReview({ baseline: 'run', mode: 'code' })
  }, [setStartError, navigateToRun, openReview])

  const handleNotificationNavigate = useCallback((target: NotificationTarget): void => {
    if (target.kind === 'flight') {
      if (target.stage) openFlightStage(target.flightId, target.stage)
      else openFlight(target.flightId)
    } else if (target.kind === 'coverage') {
      setSelectedFeature(target.feature)
      openFlightStage(target.flightId ?? derivedFlightToken(target.feature), target.stage)
    } else {
      if ('runId' in target && target.runId) navigateToRun(target.feature, target.runId)
      else { setSelectedFeature(target.feature); setSelectedRunId(null); setView('workspace') }
      // Every other target closes a review left open, and drops its focus.
      if (target.kind === 'test-review') openReview(target.runId ? { baseline: 'run', mode: 'code' } : undefined)
      else { setReviewFocus(undefined); setSpecReviewOpen(false) }
    }
  }, [navigateToRun, openFlight, openFlightStage, openReview, setReviewFocus, setSelectedFeature, setSelectedRunId, setSpecReviewOpen, setView])

  const reviewTest = useCallback((file: string, line?: number, baseline?: 'run', change?: TestChangeKind, test?: string): void => {
    openReview({ file, line, baseline, change, test, mode: 'english' })
  }, [openReview])

  const reviewStartError = useCallback((review: TestReviewRequired): void => {
    openPendingReview(review.feature, review.runId)
  }, [openPendingReview])

  const runLatestTests = useCallback((feature: string): void => {
    void handleStartRun(undefined, 'test', feature)
  }, [handleStartRun])

  const navigateCleanupRun = useCallback((feature: string, runId: string): void => {
    navigateToRun(feature, runId)
  }, [navigateToRun])

  const openCoverageGeneration = useCallback((job: CoverageJobIndexEntry): void => {
    invalidate('coverage')
    openActivity(job.feature, { kind: job.kind === 'summary' ? 'condensing' : 'mapping', jobId: job.jobId })
    // Follow the summary → mapping handoff in the Flight rail.
    setFlightStage(null)
  }, [invalidate, openActivity, setFlightStage])

  const closeFlight = useCallback((): void => {
    setSelectedFlightId(null)
    setView('workspace')
  }, [setSelectedFlightId, setView])

  /* R82: `target` is where in the run detail to land — a failed entry's name
     (the Playwright tab, at that failure) or a named tab (the stage's
     captured-fixes link → Changes). R83: both flight drill-throughs pin the
     open flight as the origin, so the destination knows where back is — the
     run detail has no close of its own, so it gets a return chip in the top
     bar instead. */
  const openFlightRun = useCallback((feature: string, runId: string, target?: RunOpenTarget): void => {
    navigateToRun(feature, runId, target, selectedFlightId)
  }, [navigateToRun, selectedFlightId])

  const openFlightCoverage = useCallback((feature: string): void => {
    navigateToCoverage(feature, selectedFlightId)
  }, [navigateToCoverage, selectedFlightId])

  const handleFlightsPickerOpenChange = useCallback((open: boolean): void => {
    if (open) { setSelectedFlightId(null); setView('flights') }
    else setView('workspace')
  }, [setSelectedFlightId, setView])

  // R40: the new-flight dialog's repo picker offers every repo the workspace
  // already knows (flattened from the features' configs, deduped by path).
  const knownRepos = useMemo<RepoOption[]>(() => {
    const seen = new Map<string, RepoOption>()
    for (const f of features) {
      for (const r of f.repos ?? []) {
        const p = r.localPath
        if (typeof p === 'string' && p.length > 0 && !seen.has(p)) {
          seen.set(p, { label: r.name || p.split(/[\\/]/).pop() || p, path: p })
        }
      }
    }
    return [...seen.values()]
  }, [features])

  const selectedFeatureEnvs =
    features.find((f) => f.name === selectedFeature)?.envs ?? []

  const contentByPanel = {
    features: (
      <FeaturesColumn
        features={featuresWithPending}
        selectedFeature={selectedFeature}
        activity={featureActivity}
        lastRuns={lastRuns}
        activeRunFeature={globalActiveRunEntry?.feature ?? null}
        activeRunStatus={globalActiveRunEntry?.status ?? null}
        activeRunWaiting={activeRunWaiting}
        activeRunExecutionType={globalActiveRunEntry?.executionType ?? null}
        onSelectFeature={selectFeature}
        onOpenConfig={openConfig}
        versionStatus={versionStatus}
        onOpenCoverage={openCoverageFor}
        onStartNewFlight={() => setFlightStartNew(true)}
        onOpenFlight={openFlight}
        flightAction={flightAction}
        settingsOpen={settingsOpen}
        onSettingsOpenChange={setSettingsOpen}
        modelsFor={modelsFor}
        onModelsFor={setModelsFor}
      />
    ),
    tests: (
      <TestCasesColumn
        feature={selectedFeature}
        isAuthoringTests={selectedFeatureActivity?.kind === 'authoring'}
        runEvidence={selectedRunEvidence}
        comparisonBaseline={selectedRunEvidence}
        currentTests={nav.currentTests}
        onCurrentTestsChange={selectedRunForFeature ? nav.setCurrentTests : undefined}
        onReviewTest={reviewTest}
        onTotalTestsChange={setSpecTotalTests}
        dirtySpecs={features.find((f) => f.name === selectedFeature)?.dirty?.specs ?? []}
      />
    ),
    runs: (
      <VerticalSplit
        storageKey="canary-lab.runs-detail-split-v2"
        defaultTopPercent={25}
        minTopPx={120}
        minBottomPx={320}
        collapsible
        top={(
          <RunsColumn
            feature={selectedFeature}
            envs={selectedFeatureEnvs}
            runs={featureRuns}
            selectedRunId={selectedRunId}
            onSelectRun={setSelectedRunId}
            onStartRun={handleStartRun}
            onStartVerification={handleStartVerification}
            runDisabled={false}
            verifyOpen={verifyOpen}
            onVerifyOpenChange={setVerifyOpen}
            /* Read straight from the server's onboarding samples rather than a
               literal suite name — so it stays correct if the shipped demo is
               ever renamed, and goes quiet once the user deletes it. */
            sampleSuite={demo.suite}
          />
        )}
        bottom={(
          <RunDetailColumn
            runId={selectedRunId}
            onOpenPlaywrightSettings={(f) => openConfig(f, 'playwright')}
            onOpenSpecReview={openPendingReview}
            onOpenEvaluationReport={openEvaluationReport}
            totalTests={specTotalTests}
            /* Honoured only when the focus belongs to the run being shown, so a
               stale pair from a previous selection can't scroll this one. */
            {...(focusTest && focusTest.runId === selectedRunId ? { focusTest: focusTest.test, focusTestId: focusTest.testId, focusTestLocation: focusTest.testLocation } : {})}
            /* Same pairing rule for the arrival tab a drill-through named. */
            {...(runTab && runTab.runId === selectedRunId ? { arriveTab: runTab.tab } : {})}
            bootFailureOpen={bootFailureFor !== null && bootFailureFor === selectedRunId}
            onBootFailureOpenChange={(open) => setBootFailureFor(open ? selectedRunId : null)}
          />
        )}
      />
    ),
  } satisfies Record<(typeof WORKSPACE_PANELS)[number]['id'], ReactNode>

  // The picker's open-state is routed (`view=flights` with no flight selected);
  // its rows read WorkState and WorkspaceActions.
  const flightPill: FlightsPillProps = {
    open: view === 'flights' && !selectedFlightId,
    onOpenChange: handleFlightsPickerOpenChange,
  }

  const approvals = useApprovals()
  const pendingApprovals = approvals.items.filter((item) => item.status === 'pending')
  const review = {
    features,
    onFeaturesChanged: refreshFeatures,
    runId: selectedRunId,
    feature: selectedFeature,
    runDetail: statusRunDetail.detail,
    focus: reviewFocus,
    onFocus: setReviewFocus,
    onChooseFeature: selectFeatureForReview,
    open: specReviewOpen,
    onOpenChange: setSpecReviewOpen,
  }

  return (
    <div className="flex h-full w-full flex-col">
      <GlobalStatusBar
        recordSyncControl={<WorkspaceRecordSyncStatus />}
        activeRunDetail={activeRunDetail}
        onRunLatestTests={runLatestTests}
        runStartPending={pendingStarts.length > 0 || !!modelsPrompt || !!collisionPrompt}
        onOpenCleanup={() => setView('cleanup')}
        flightPill={flightPill}
        review={review}
        gettingStarted={{ available: demo.available, unseen: demo.unseen, onOpen: openDemo }}
        returnToFlight={returnFlight ? { flightId: returnFlight, label: returnFlightLabel, onOpen: openFlight } : null}
        notificationControl={<NotificationCenter approvals={approvals} approvalFocus={nav.approval} open={nav.notificationsOpen} onOpenChange={nav.setNotificationsOpen} onNavigate={handleNotificationNavigate} />}
      />
      {(pendingApprovals.length > 0 || approvals.error) && <div role="status" className="flex items-center gap-3 border-b border-line bg-surface px-4 py-2 text-xs">
        <span>{approvals.error ? 'Approval status unavailable. Retrying…' : `${plural(pendingApprovals.length, 'approval')} waiting for you`}</span>
        {pendingApprovals.map((item) => <button key={item.id} className="cl-button px-2 py-1" onClick={() => { nav.setApproval(item.id); nav.setNotificationsOpen(true) }}>
          Review approval{item.feature ? ` · ${item.feature}` : ''}
        </button>)}
      </div>}
      {pendingStarts.map((pending) => <PendingRunStartNotice key={pending.requestId} pending={pending}
        onDismiss={dismissPendingStart} onRunStarted={(runId) => navigateToRun(pending.feature, runId)}
        onReview={openPendingReview} />)}
      <div className="min-h-0 flex-1">
        {/* One-time chunk load for a lazy view — a quiet line on the app's own
            canvas, gone in well under a second on a local server. */}
        <Suspense fallback={<div className="flex h-full items-center justify-center text-xs text-muted">Loading…</div>}>
        {view === 'cleanup'
          ? <LogCleanupPage
              onClose={() => setView('workspace')}
              onNavigateToRun={navigateCleanupRun}
            />
          : view === 'coverage' && selectedFeature
          ? <CoverageLedgerPage
              feature={selectedFeature}
              /* R83: the ledger is a top-level VIEW, so a flight's drill-through
                 replaces the flight rather than stacking on it. Close returns to
                 the flight that opened it; opened on its own, it still exits to
                 the workspace. */
              onClose={() => returnFlight ? openFlight(returnFlight) : setView('workspace')}
              generatingFlight={coverageGeneratingFlight}
              onOpenFlight={openFlight}
              coverageJobs={coverageJobs}
              onOpenRecovery={(stage, models) => {
                recalculation.start(selectedFeature, stage, models)
              }}
              onOpenGeneration={openCoverageGeneration}
            />
          : view === 'flights' && selectedFlightId
          ? <FlightPage
              flightId={selectedFlightId}
              recalculation={flightRecalculation}
              onRetryRecalculation={() => {
                if (flightRecalculation) recalculation.start(flightRecalculation.feature, flightRecalculation.stage, flightRecalculation.launchModels)
              }}
              // The manifest `/ws/flights` pushed for this flight, when it has
              // one — an active flight then advances from the push instead of
              // the detail view polling for it.
              liveFlight={flightDetails[selectedFlightId] ?? null}
              onFlightMissing={forgetFlight}
              missing={flightsHydrated && !flights.some((f) => f.flightId === selectedFlightId)}
              // The index row seeds the header/strip/rail on a cold open of a
              // settled flight (which the push channel never snapshots).
              indexEntry={flights.find((f) => f.flightId === selectedFlightId) ?? null}
              // Select the feature too: the config dialog is qualified by the
              // durable `feature` param, so opening it for a flight's feature
              // while a DIFFERENT one is selected would deep-link to the wrong
              // suite. Same alignment onStartFlight already does below.
              onOpenConfig={openConfig}
              onSelectFlight={setSelectedFlightId}
              onClose={closeFlight}
              onOpenRun={openFlightRun}
              onOpenCoverage={openFlightCoverage}
              /* The stage pick is routed (?stage=…) rather than local to the
                 detail: a drill-through replaces this whole view, so without an
                 owner above it the way back remounted the detail and re-ran its
                 auto-pick — landing on the last done stage, not the one left. */
              stage={flightStage}
              onSelectStage={setFlightStage}
              /* The stage Activity's open log entry is routed too (?log=…), so
                 a refresh or a shared link reopens the same entry. */
              log={flightLog}
              onOpenLog={setFlightLog}
              onStartFlight={workspace.startFlight}
              /* The run hero's "verdict from run-start snapshot · N pending
                 edits" link lands on the same review the status-bar pill
                 opens — one dialog, routed once (?dialog=tests-review). */
              onOpenSpecReview={openPendingReview}
            />
          : <ResizablePanels panels={WORKSPACE_PANELS} contentByPanel={contentByPanel} />}
        </Suspense>
      </div>
      <DemoDialog
        open={demoOpen}
        onClose={() => setDemoOpen(false)}
        workflows={demo.workflows}
        session={demo.session}
        actionBlockers={actionBlockers}
        onInternalAction={launchDemo}
        onOpenTarget={openTarget}
        showDemo={demo.showDemo}
        onShowDemoChange={demo.setShowDemo}
      />
      {(flightStartFor !== null || flightStartNew) && (
        <FlightStartDialog
          feature={flightStartNew ? null : flightStartFor}
          intent={flightStartFresh ? 'fresh' : 'refly'}
          fromStage={flightStartNew ? null : flightStartStage}
          resumePlanTaskId={flightStartNew ? resumePlanTaskId : null}
          knownRepos={knownRepos}
          onClose={() => { setFlightStartFor(null); setFlightStartNew(false); setResumePlanTaskId(null) }}
          onOpenFlight={(flightId) => {
            setFlightStartFor(null)
            setFlightStartNew(false)
            setResumePlanTaskId(null)
            setSelectedFlightId(flightId)
            setView('flights')
            refreshFlights()
          }}
        />
      )}
      {configFor && (
        <FeatureConfigEditor
          feature={configFor}
          // Routed mount: the open tab lives in the URL (?dialog=config&tab=…),
          // so a drill-through can aim at one and a refresh lands back on it.
          // No tab from the opener = Playwright, this mount's long-standing
          // default (the run detail's artifact-settings entry point).
          tab={configTab ?? 'playwright'}
          onTabChange={setConfigTab}
          portified={features.find((f) => f.name === configFor)?.portified ?? false}
          onOpenPortify={openPortifyStage}
          onClose={() => setConfigFor(null)}
          onRenamed={(_, nextFeature) => {
            // refreshFeatures(nextFeature) refetches the list and re-selects the
            // renamed feature + its latest run (same as the old inline handler).
            // Carry the open tab across the rename — reopening bare would snap
            // the user from General (where the rename happens) to the default.
            setConfigFor(nextFeature, configTab)
            refreshFeatures(nextFeature)
          }}
          onDeleted={() => {
            // refreshFeatures() refetches and, when the (now-gone) selected feature
            // drops out of the list, falls back to the first — matching the old
            // "re-select only if the deleted feature was selected" behavior.
            setConfigFor(null)
            refreshFeatures()
          }}
        />
      )}
      {modelsPrompt && (
        <ModelLaunchGate
          launchNoun="run"
          agent={modelsPrompt.agent}
          stages={RUN_MODEL_STAGES}
          config={modelsPrompt.agentModels}
          onCancel={() => setModelsPrompt(null)}
          onConfirm={(models) => { void resolveModelsPrompt(models) }}
          confirmLabel="Start run"
        />
      )}
      {collisionPrompt && (
        <CollisionConfirmDialog
          info={collisionPrompt.info}
          feature={collisionPrompt.feature}
          portsConfigured={collisionPrompt.portsConfigured}
          onPortify={() => { const f = collisionPrompt.feature; setCollisionPrompt(null); openPortifyStage(f) }}
          onChoose={resolveCollision}
          onCancel={() => setCollisionPrompt(null)}
        />
      )}
      {startError && (
        <RunStartErrorDialog
          error={startError.error}
          feature={startError.feature}
          onRetry={() => { void retryStartError() }}
          onReviewTests={reviewStartError}
          onSwitchBranches={switchBranchesAndRun}
          onPinCurrent={pinCurrentAndRun}
          onClose={() => setStartError(null)}
        />
      )}
    </div>
  )
}
