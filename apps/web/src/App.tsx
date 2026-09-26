import { Suspense, lazy, useCallback, useMemo, useState, type ReactNode } from 'react'
import { FeaturesColumn } from './shared/shell/FeaturesColumn'
import { TestCasesColumn } from './shared/shell/TestCasesColumn'
import { RunsColumn } from './features/runs/components/RunsColumn'
import { DemoDialog, useGettingStarted } from './features/getting-started'
import { RunDetailColumn } from './features/runs/components/RunDetailColumn'
import { FeatureConfigEditor } from './features/config/components/FeatureConfigEditor'
import { ModelLaunchGate } from './features/config'
import { ResizablePanels, type PanelConfig } from './shared/ui/ResizablePanels'
import { VerticalSplit } from './shared/ui/VerticalSplit'
import { GlobalStatusBar } from './shared/shell/GlobalStatusBar'
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
import { runWaitingState } from './features/runs'
import { useRuns, useGlobalActiveRun } from './features/runs/state/RunsContext'
import { useRunStart } from './features/runs/state/use-run-start'
import { useWorkspaceFlights, resolveFeatureFlightTarget, type FeatureActivity, type FlightsPillProps } from './features/flights'
import { derivedFlightFeature, derivedFlightToken } from './features/flights/lib/derived-stages'
import type { RepoOption } from './features/flights/components/RepoMultiPicker'
import { NotificationCenter } from './features/notifications/NotificationCenter'
import { useInvalidation } from './shared/state/invalidation'
import { useWorkspaceNavigation } from './shared/state/use-workspace-navigation'
import { useWorkspaceData } from './shared/state/use-workspace-data'
import { useWorkspaceSelection } from './shared/state/use-workspace-selection'
import { resolveActivityTarget } from './shared/state/nav-state'
import type { FlightStageKey, ModelStageKey } from './shared/api/client'
import type { NotificationTarget } from './shared/api/notifications'

// The two stages a suite run spawns — the models gate scopes its rows to them.
const RUN_MODEL_STAGES: readonly ModelStageKey[] = ['heal', 'commit']
const WORKSPACE_PANELS = [
  { id: 'features', minWidth: 180, defaultWidth: 220, collapsible: true, collapseButtonY: 'top' },
  { id: 'tests', minWidth: 280, defaultWidth: 360, collapsible: true, collapseButtonY: 'bottom' },
  { id: 'runs', minWidth: 400, defaultWidth: 500, collapsible: false },
] as const satisfies readonly PanelConfig[]

export function App() {
  const [specTotalTests, setSpecTotalTests] = useState(0)
  // Navigation — view / feature / run / flight + the routed dialogs, plus URL
  // persistence, cross-tab sync, and the selection-mirror refs. Destructured so
  // the rest of App keeps the same names; the logic lives in the hook (its
  // non-trivial parts are covered by nav-state's pure tests).
  const nav = useWorkspaceNavigation()
  const {
    view, setView,
    selectedFeature, setSelectedFeature,
    selectedRunId, setSelectedRunId,
    selectedFlightId, setSelectedFlightId,
    configFor, setConfigFor, openConfig, configTab, setConfigTab,
    verifyOpen, setVerifyOpen,
    specReviewOpen, setSpecReviewOpen, reviewFocus, setReviewFocus,
    flightStartFor, flightStartFresh, flightStartStage, setFlightStartFor,
    flightStartNew, setFlightStartNew,
    demoOpen, setDemoOpen,
    settingsOpen, setSettingsOpen, modelsFor, setModelsFor,
    resumePlanTaskId, setResumePlanTaskId,
    focusTest, runTab, bootFailureFor, setBootFailureFor,
    openFlight, navigateToRun, navigateToCoverage, returnFlight, selectStartedRun,
    flightStage, setFlightStage,
    pendingRunSelectionRef, selectedFeatureRef, selectedRunIdRef,
  } = nav

  // Runs come from the WebSocket-backed RunsProvider — no polling here. `runs` is
  // the full index across all features; the per-feature filter happens at render.
  const { runs: allRuns, startRun: startRunAction, startVerification: startVerificationAction } = useRuns()
  // Cross-feature refetch bus — the WS handler publishes topic invalidations that
  // fetch-owning leaves subscribe to (replaces the drilled `*RefreshKey`s).
  const { invalidate } = useInvalidation()

  const {
    featureRuns, selectedRunForFeature, statusRunDetail, selectedRunEvidence,
    onInitialFeatures, onFeaturesRefreshed, selectFeature, selectFeatureForReview,
  } = useWorkspaceSelection({
    allRuns, selectedFeature, selectedRunId, setSelectedFeature, setSelectedRunId,
    selectedFeatureRef, selectedRunIdRef, pendingRunSelectionRef,
  })

  // The data hook owns fetches and workspace events; selection stays with
  // the controller above so reconnects and manual navigation use one policy.
  const {
    features, flights, flightDetails, flightsRef, preFlights, versionStatus,
    refreshFeatures, refreshFlights, refreshPreFlights, refreshVersion,
  } = useWorkspaceData({
    invalidate,
    onInitialFeatures,
    onFeaturesRefreshed,
    selectedFeatureRef,
    selectedRunIdRef,
    // A rename anywhere (this tab, another tab, an MCP client) must move the
    // open config dialog with the suite instead of leaving it on a name the
    // server no longer resolves.
    onFeatureRenamed: (from, to) => { if (configFor === from) setConfigFor(to, configTab) },
  })

  const { entry: globalActiveRunEntry, detail: activeRunDetail } = useGlobalActiveRun()
  const activeRunWaiting = runWaitingState(activeRunDetail ?? globalActiveRunEntry)
  const invalidateCoverage = useCallback(() => invalidate('coverage'), [invalidate])
  const {
    activity: featureActivity, externalHistory: featureExternalHistory,
    coverageJobs, portifyWorkflows, derivedStages, selectedFeatureActivity,
    flightAction, featuresWithPending, pickerFeatures, coverageGeneratingFlight,
  } = useWorkspaceFlights({ features, flights, selectedFeature, refreshFeatures, invalidateCoverage })
  // Stable identity on purpose: FeaturesColumn holds this in a fetch effect's
  // dep list, and a fresh arrow per render made it refetch every feature's
  // coverage on every render. The column guards against that too — this keeps
  // the prop honest at the source.
  // No origin flight: this is the user opening the ledger on their own, so any
  // way-back a previous drill-through left is cleared.
  const openCoverageFor = useCallback((feature: string): void => {
    navigateToCoverage(feature)
  }, [navigateToCoverage])

  const openFlightStage = useCallback((flightId: string, stage: FlightStageKey): void => {
    openFlight(flightId)
    // Opening a different flight resets its stage, so set the destination after.
    setFlightStage(stage)
  }, [openFlight, setFlightStage])

  const openFeatureStage = useCallback((feature: string, stage: FlightStageKey): void => {
    setSelectedFeature(feature)
    openFlightStage(resolveFeatureFlightTarget(feature, flightsRef.current).flightId, stage)
  }, [flightsRef, openFlightStage, setSelectedFeature])

  // Portify is a Flight stage, regardless of whether a conductor record exists.
  const openPortifyStage = useCallback((feature: string): void => {
    setConfigFor(null)
    openFeatureStage(feature, 'portify')
  }, [openFeatureStage, setConfigFor])

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

  // Clicking a live activity row opens the activity's REAL surface. The routing
  // decision is the pure `resolveActivityTarget`; App maps the target to nav.
  const openActivity = useCallback((feature: string, activity: FeatureActivity) => {
    const target = resolveActivityTarget(feature, activity, flightsRef.current)
    if (target.kind === 'run') navigateToRun(target.feature, target.runId)
    else if (target.stage) openFlightStage(target.flightId, target.stage)
    else openFlight(target.flightId)
  }, [navigateToRun, openFlight, openFlightStage, flightsRef])

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
    setReviewFocus({ baseline: 'run', mode: 'code' })
    setSpecReviewOpen(true)
  }, [setStartError, navigateToRun, setReviewFocus, setSpecReviewOpen])

  const handleNotificationNavigate = (target: NotificationTarget): void => {
    if (target.kind === 'flight') {
      openFlight(target.flightId)
    } else if (target.kind === 'coverage') {
      setSelectedFeature(target.feature)
      openFlightStage(target.flightId ?? derivedFlightToken(target.feature), target.stage)
    } else {
      if ('runId' in target && target.runId) navigateToRun(target.feature, target.runId)
      else { setSelectedFeature(target.feature); setSelectedRunId(null); setView('workspace') }
      setReviewFocus(target.kind === 'test-review' && target.runId ? { baseline: 'run', mode: 'code' } : undefined)
      setSpecReviewOpen(target.kind === 'test-review')
    }
  }

  const handleFlightsPickerOpenChange = useCallback((open: boolean): void => {
    if (open) { setSelectedFlightId(null); setView('flights') }
    else setView('workspace')
  }, [setSelectedFlightId, setView])

  const handlePreFlightOpen = useCallback((taskId: string): void => {
    setResumePlanTaskId(taskId)
    setFlightStartNew(true)
  }, [setResumePlanTaskId, setFlightStartNew])

  const handleStartFlight = useCallback((feature: string): void => {
    setSelectedFeature(feature)
    setFlightStartFor(feature)
  }, [setSelectedFeature, setFlightStartFor])

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
        activeRunFeature={globalActiveRunEntry?.feature ?? null}
        activeRunStatus={globalActiveRunEntry?.status ?? null}
        activeRunWaiting={activeRunWaiting}
        activeRunExecutionType={globalActiveRunEntry?.executionType ?? null}
        onSelectFeature={selectFeature}
        onReviewFeature={(name) => { setSelectedFeature(name); setReviewFocus(undefined); setSpecReviewOpen(true) }}
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
        onReviewTest={(file, line, baseline, change, test) => { setReviewFocus({ file, line, baseline, change, test, mode: 'english' }); setSpecReviewOpen(true) }}
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
            onOpenSpecReview={() => setSpecReviewOpen(true)}
            onOpenEvaluationReport={openEvaluationReport}
            totalTests={specTotalTests}
            /* Honoured only when the focus belongs to the run being shown, so a
               stale pair from a previous selection can't scroll this one. */
            {...(focusTest && focusTest.runId === selectedRunId ? { focusTest: focusTest.test } : {})}
            /* Same pairing rule for the arrival tab a drill-through named. */
            {...(runTab && runTab.runId === selectedRunId ? { arriveTab: runTab.tab } : {})}
            bootFailureOpen={bootFailureFor !== null && bootFailureFor === selectedRunId}
            onBootFailureOpenChange={(open) => setBootFailureFor(open ? selectedRunId : null)}
          />
        )}
      />
    ),
  } satisfies Record<(typeof WORKSPACE_PANELS)[number]['id'], ReactNode>

  const flightPill: FlightsPillProps = {
    flights,
    preFlights,
    activity: featureActivity,
    features: pickerFeatures,
    coverageJobs,
    portifyWorkflows,
    open: view === 'flights' && !selectedFlightId,
    onOpenChange: handleFlightsPickerOpenChange,
    onOpenFlight: openFlight,
    onOpenActivity: openActivity,
    onOpenPreFlight: handlePreFlightOpen,
    onStartFlight: handleStartFlight,
  }

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
        activeRunDetail={activeRunDetail}
        onRunLatestTests={(feature) => { void handleStartRun(undefined, 'test', feature) }}
        runStartPending={pendingStarts.length > 0 || !!modelsPrompt || !!collisionPrompt}
        onOpenCleanup={() => setView('cleanup')}
        flightPill={flightPill}
        review={review}
        gettingStarted={{ available: demo.available, unseen: demo.unseen, onOpen: openDemo }}
        returnToFlight={returnFlight ? { flightId: returnFlight, label: returnFlightLabel, onOpen: openFlight } : null}
        onOpenPortify={openPortifyStage}
        onNavigateToRun={navigateToRun}
        notificationControl={<NotificationCenter open={nav.notificationsOpen} onOpenChange={nav.setNotificationsOpen} onNavigate={handleNotificationNavigate} />}
      />
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
              onNavigateToRun={(feature, runId) => navigateToRun(feature, runId)}
              onNavigateToPortify={openPortifyStage}
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
              onOpenRecovery={(stage) => {
                openFeatureStage(selectedFeature, stage)
                setFlightStartFor(selectedFeature, 'refly', stage)
              }}
              onOpenGeneration={(job) => {
                invalidate('coverage')
                openActivity(job.feature, { kind: job.kind === 'summary' ? 'condensing' : 'mapping', jobId: job.jobId })
                // Follow the summary → mapping handoff in the Flight rail.
                setFlightStage(null)
              }}
            />
          : view === 'flights' && selectedFlightId
          ? <FlightPage
              flightId={selectedFlightId}
              // The manifest `/ws/flights` pushed for this flight, when it has
              // one — an active flight then advances from the push instead of
              // the detail view polling for it.
              liveFlight={flightDetails[selectedFlightId] ?? null}
              // The index row seeds the header/strip/rail on a cold open of a
              // settled flight (which the push channel never snapshots).
              indexEntry={flights.find((f) => f.flightId === selectedFlightId) ?? null}
              activity={featureActivity}
              externalHistory={featureExternalHistory}
              coverageJobs={coverageJobs}
              derivedStages={derivedStages}
              // Select the feature too: the config dialog is qualified by the
              // durable `feature` param, so opening it for a flight's feature
              // while a DIFFERENT one is selected would deep-link to the wrong
              // suite. Same alignment onStartFlight already does below.
              onOpenConfig={openConfig}
              onSelectFlight={setSelectedFlightId}
              onClose={() => { setSelectedFlightId(null); setView('workspace') }}
              /* R82: `target` is where in the run detail to land — a failed
                 entry's name (the Playwright tab, at that failure) or a named tab
                 (the stage's captured-fixes link → Changes). navigateToRun does
                 exactly what this handler used to inline, plus the run pairing.
                 R83: both drill-throughs pin THIS flight as the origin, so the
                 destination knows where back is — the run detail has no close of
                 its own, so it gets a return chip in the top bar instead. */
              onOpenRun={(feature, runId, target) => navigateToRun(feature, runId, target, selectedFlightId)}
              onOpenCoverage={(feature) => navigateToCoverage(feature, selectedFlightId)}
              /* The stage pick is routed (?stage=…) rather than local to the
                 detail: a drill-through replaces this whole view, so without an
                 owner above it the way back remounted the detail and re-ran its
                 auto-pick — landing on the last done stage, not the one left. */
              stage={flightStage}
              onSelectStage={setFlightStage}
              onStartFlight={(feature, intent, fromStage) => { setSelectedFeature(feature); setFlightStartFor(feature, intent, fromStage) }}
              /* The run hero's "verdict from run-start snapshot · N pending
                 edits" link lands on the same review the status-bar pill
                 opens — one dialog, routed once (?dialog=tests-review). */
              onOpenSpecReview={() => setSpecReviewOpen(true)}
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
          onReviewTests={(review) => openPendingReview(review.feature, review.runId)}
          onSwitchBranches={switchBranchesAndRun}
          onPinCurrent={pinCurrentAndRun}
          onClose={() => setStartError(null)}
        />
      )}
    </div>
  )
}
