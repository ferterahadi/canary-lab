import { useCallback, useEffect, useMemo, useState } from 'react'
import { FeaturesColumn } from './shared/shell/FeaturesColumn'
import { TestCasesColumn } from './shared/shell/TestCasesColumn'
import { RunsColumn } from './features/runs/components/RunsColumn'
import { FirstRunGuide } from './shared/shell/FirstRunGuide'
import { useFirstRunGuide } from './shared/state/first-run-guide'
import { RunDetailColumn } from './features/runs/components/RunDetailColumn'
import { FeatureConfigEditor } from './features/config/components/FeatureConfigEditor'
import { ResizablePanels } from './shared/ui/ResizablePanels'
import { VerticalSplit } from './shared/ui/VerticalSplit'
import { GlobalStatusBar } from './shared/shell/GlobalStatusBar'
import { CollisionConfirmDialog } from './features/runs/components/CollisionConfirmDialog'
import { RunStartErrorDialog } from './features/runs/components/RunStartErrorDialog'
import { PortifyWizard } from './features/portify/components/PortifyWizard'
import { DraftDialog } from './features/wizard/components/DraftDialog'
import { LogCleanupPage } from './features/cleanup/components/LogCleanupPage'
import { CoverageLedgerPage } from './features/coverage/components/CoverageLedgerPage'
import { FlightPage } from './features/flights/components/FlightPage'
import { FlightStartDialog } from './features/flights/components/FlightStartDialog'
import { useRuns, useRun, useGlobalActiveRun } from './features/runs/state/RunsContext'
import { useRunStart } from './features/runs/state/use-run-start'
import { useFeatureActivity, type FeatureActivity } from './features/flights/state/feature-activity'
import { resolveFeatureFlightAction } from './features/flights'
import { derivedFlightFeature, useDerivedFeatureStages } from './features/flights/lib/derived-stages'
import { derivePendingFeatures } from './features/flights/lib/pending-features'
import type { RepoOption } from './features/flights/components/RepoMultiPicker'
import { ToastHost } from '@/shared/ui/atoms'
import { useFlightToasts } from './features/flights/state/use-flight-toasts'
import { useInvalidation } from './shared/state/invalidation'
import { useWorkspaceNavigation } from './shared/state/use-workspace-navigation'
import { useWorkspaceData } from './shared/state/use-workspace-data'
import { resolveActivityTarget } from './shared/state/nav-state'

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
    configFor, setConfigFor, configTab, setConfigTab,
    verifyOpen, setVerifyOpen,
    flightStartFor, flightStartFresh, flightStartStage, setFlightStartFor,
    flightStartNew, setFlightStartNew,
    draftFor, setDraftFor,
    resumePlanTaskId, setResumePlanTaskId,
    portifyTarget, setPortifyTarget,
    focusTest, runTab,
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

  // Server-sourced data (features / flights / pre-flights / version) + the
  // refresh helpers + the /ws/workspace wiring live in one hook. The nav
  // selection it must touch comes in as setters + refs; the render-coupled
  // run-selection reconciliation stays below where `featureRuns` is derived.
  const {
    features, flights, flightsRef, preFlights, versionStatus,
    refreshFeatures, refreshFlights, refreshPreFlights, refreshVersion,
  } = useWorkspaceData({
    invalidate,
    allRuns,
    initialSelectedFeature: selectedFeature,
    setSelectedFeature,
    setSelectedRunId,
    selectedFeatureRef,
    selectedRunIdRef,
    pendingRunSelectionRef,
    // A rename anywhere (this tab, another tab, an MCP client) must move the
    // open config dialog with the suite instead of leaving it on a name the
    // server no longer resolves.
    onFeatureRenamed: (from, to) => { if (configFor === from) setConfigFor(to) },
  })

  const { entry: globalActiveRunEntry, detail: activeRunDetail } = useGlobalActiveRun()
  // R26: per-feature live activity (runs / portify / authoring) — the one
  // instance behind the Flights pill and the flights landing list. Clicking an
  // activity-only row opens the activity's REAL surface.
  const featureActivity = useFeatureActivity()
  // Evidence-derived stage rails for flightless picker rows — one instance,
  // same ownership rule as featureActivity (the pill stays presentational).
  const derivedStages = useDerivedFeatureStages(features)
  // First-run guide — the workspace's tour of the two samples `init` shipped.
  // One owner for both steps (see shared/state/first-run-guide.ts); the two
  // columns below only render the step they host.
  const guide = useFirstRunGuide(allRuns, flights)
  // Set only when the new-flight dialog is opened FROM the guide, so the plain
  // "+ New" button still opens an empty form. Deliberately not routed: a cold
  // load of `?dialog=flight-new` has no guide behind it, and an empty form is
  // the honest thing to land on.
  const [guideFlightPrefill, setGuideFlightPrefill] = useState<{ repoPaths: string[]; description: string } | null>(null)
  // The Features column's per-row flight shortcut — one jump from a suite to its
  // flight instead of the pill → picker → find-the-row detour. Same inputs the
  // picker rows resolve from, so the two agree on where a suite's flight lives
  // (a recorded id, or the `feature:` derived token for progress made outside
  // the conductor) and on the state the icon reports.
  // Stable identity on purpose: FeaturesColumn holds this in a fetch effect's
  // dep list, and a fresh arrow per render made it refetch every feature's
  // coverage on every render. The column guards against that too — this keeps
  // the prop honest at the source.
  // No origin flight: this is the user opening the ledger on their own, so any
  // way-back a previous drill-through left is cleared.
  const openCoverageFor = useCallback((feature: string): void => {
    navigateToCoverage(feature)
  }, [navigateToCoverage])

  // R83: what the return chip says. The origin is whatever `flight` held — a
  // recorded id (name it from the index) or a `feature:<name>` derived token
  // (the name IS the token). An id the index no longer carries still gets a
  // chip: the way back matters more than the label.
  const returnFlightLabel = useMemo(() => {
    if (!returnFlight) return null
    return flights.find((f) => f.flightId === returnFlight)?.feature
      ?? derivedFlightFeature(returnFlight)
  }, [returnFlight, flights])

  const flightAction = useCallback(
    (feature: string) => resolveFeatureFlightAction(feature, flights, featureActivity.get(feature), derivedStages.get(feature)),
    [flights, featureActivity, derivedStages],
  )
  // Clicking a live activity row opens the activity's REAL surface. The routing
  // decision is the pure `resolveActivityTarget`; App maps the target to nav.
  const openActivity = useCallback((feature: string, activity: FeatureActivity) => {
    const target = resolveActivityTarget(feature, activity, flightsRef.current)
    if (target.kind === 'run') navigateToRun(target.feature, target.runId)
    else if (target.kind === 'flight') {
      openFlight(target.flightId)
      // openFlight clears the stage when the flight changes, so pin it after.
      if (target.stage) setFlightStage(target.stage)
    }
    else if (target.kind === 'draft') setDraftFor(target.draftId)
    else setPortifyTarget({ kind: 'revisit', workflowId: target.workflowId })
  }, [navigateToRun, openFlight, setFlightStage, setPortifyTarget, setDraftFor, flightsRef])

  // Column 3 lists runs scoped to the currently-selected feature. Boot-only
  // sessions are excluded — they're not test runs and live in the global
  // Services surface, not the Runs list.
  const featureRuns = useMemo(
    () => allRuns.filter((r) => r.feature === selectedFeature && r.executionType !== 'boot' && r.executionType !== 'benchmark'),
    [allRuns, selectedFeature],
  )

  // Latest run for the selected feature — running, healing, OR terminal.
  // Used as the default test-status source only until the user explicitly
  // selects a run from the runs column.
  const latestRunForFeature = featureRuns[0] ?? null
  const selectedRunForFeature = selectedRunId
    ? featureRuns.find((r) => r.runId === selectedRunId) ?? null
    : null
  const statusRunId = selectedRunForFeature?.runId ?? latestRunForFeature?.runId ?? null

  useEffect(() => {
    if (!selectedFeature) {
      pendingRunSelectionRef.current = null
      if (selectedRunId !== null) setSelectedRunId(null)
      return
    }

    if (selectedRunForFeature) {
      if (pendingRunSelectionRef.current === selectedRunForFeature.runId) {
        pendingRunSelectionRef.current = null
      }
      return
    }

    if (selectedRunId && pendingRunSelectionRef.current === selectedRunId) return

    const nextRunId = latestRunForFeature?.runId ?? null
    if (selectedRunId !== nextRunId) setSelectedRunId(nextRunId)
  }, [latestRunForFeature?.runId, selectedFeature, selectedRunForFeature, selectedRunId])

  // The detail (and therefore the summary) for Column 2 lives in the shared
  // run store. It is scoped to the selected run when there is one, so clicking
  // Run 1 / Run 2 updates the test status pills to that run's result.
  const statusRunDetail = useRun(statusRunId)
  const summaryForSelectedFeature = statusRunDetail.detail?.summary
  const statusForSelectedFeature =
    statusRunDetail.detail?.manifest.status
    ?? selectedRunForFeature?.status
    ?? latestRunForFeature?.status

  // The run-start flow (collision prompt, branch-mismatch recovery, silent-
  // failure guard) lives in useRunStart — App just wires selection + the dialogs.
  const {
    collisionPrompt, setCollisionPrompt,
    startError, setStartError,
    handleStartRun, resolveCollision, switchBranchesAndRun, pinCurrentAndRun,
    handleStartVerification,
  } = useRunStart({
    selectedFeature,
    startRun: startRunAction,
    startVerification: startVerificationAction,
    onRunStarted: selectStartedRun,
  })

  // R14: the coverage ledger's content is generated by a flight's docs /
  // prd-summary / specs-coverage stages — hand the ledger that fact so it can
  // say "generating" instead of sitting silently empty while a flight works.
  const coverageGeneratingFlight = useMemo(() => {
    if (!selectedFeature) return null
    const flight = flights.find((f) =>
      (f.status === 'running' || f.status === 'waiting-for-approval') && f.feature === selectedFeature)
    const stageKey = flight?.currentStage
    if (!flight || !stageKey) return null
    if (stageKey !== 'docs' && stageKey !== 'prd-summary' && stageKey !== 'specs-coverage') return null
    const stageStatus = flight.stages?.find((s) => s.key === stageKey)?.status ?? 'running'
    return { flightId: flight.flightId, stage: stageKey, stageStatus }
  }, [flights, selectedFeature])

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

  // R51/R68: attention toasts — diff flight statuses on every index refresh and
  // toast a flight the moment it starts needing the user (waiting-for-approval,
  // or a non-user / non-queue pause). These are STICKY (never auto-dismiss) so a
  // laptop-sleep-reconnect nag isn't gone by the time the user looks. R68 fixes:
  //  - the seed pass no longer swallows already-waiting flights: on first load,
  //    if N flights already need input, fire ONE aggregate sticky toast (a storm
  //    of per-flight toasts on boot would be noise);
  //  - a flight FIRST SEEN in an attention state after seed fires its own toast
  //    (the old code skipped `was === undefined`, so a reconnect that revealed a
  //    freshly-parked flight never toasted);
  //  - queued flights never toast (they wait on capacity, not the user).
  // An individual flight's toast is suppressed only while THAT flight's detail is
  // on screen; the aggregate + other flights' toasts still show.
  // The attention-toast diff (seed/aggregate/transition/suppress rules) lives in
  // the pure `diffFlightToasts`; the hook owns the toast list + prev-key ref.
  const { toasts, dismissToast } = useFlightToasts(flights, view, selectedFlightId, {
    openFlight: (id) => openFlight(id),
    openFlightsView: () => setView('flights'),
  })

  const selectedFeatureEnvs =
    features.find((f) => f.name === selectedFeature)?.envs ?? []

  // R69: a First-Flight batch launch mints its flights before scaffolding their
  // feature dirs, so the ledger would show nothing until each flight reaches
  // scaffold. Derive placeholder rows from the (already-live) flights list so
  // the whole batch — with its group — appears in the Features column the
  // instant "Start N flights" fires; each stub swaps for the real feature once
  // scaffold writes the config and `feature-created` refetches the list.
  const featuresWithPending = useMemo(() => {
    const pending = derivePendingFeatures(flights, features)
    return pending.length ? [...features, ...pending] : features
  }, [features, flights])

  const panels = [
    {
      id: 'features',
      minWidth: 180,
      defaultWidth: 220,
      collapsible: true,
      collapseButtonY: 'top' as const,
      content: (
        <FeaturesColumn
          features={featuresWithPending}
          selectedFeature={selectedFeature}
          activeRunFeature={globalActiveRunEntry?.feature ?? null}
          activeRunStatus={globalActiveRunEntry?.status ?? null}
          activeRunExecutionType={globalActiveRunEntry?.executionType ?? null}
          onSelectFeature={(name) => {
            pendingRunSelectionRef.current = null
            setSelectedFeature(name)
            setSelectedRunId(allRuns.find((r) => r.feature === name && r.executionType !== 'boot' && r.executionType !== 'benchmark')?.runId ?? null)
          }}
          onFeaturesChanged={refreshFeatures}
          versionStatus={versionStatus}
          onOpenCoverage={openCoverageFor}
          onStartNewFlight={() => setFlightStartNew(true)}
          guide={guide.step === 'start-flight' ? (
            <FirstRunGuide
              step="start-flight"
              onDismiss={() => guide.dismiss('start-flight')}
              onAction={() => { setGuideFlightPrefill(guide.flightPrefill); setFlightStartNew(true) }}
            />
          ) : undefined}
          onOpenFlight={openFlight}
          flightAction={flightAction}
          onStartPortify={(f) => setPortifyTarget({ kind: 'new', feature: f })}
          onOpenPortify={(workflowId) => setPortifyTarget({ kind: 'revisit', workflowId })}
        />
      ),
    },
    {
      id: 'tests',
      minWidth: 280,
      defaultWidth: 360,
      collapsible: true,
      collapseButtonY: 'bottom' as const,
      content: (
        <TestCasesColumn
          feature={selectedFeature}
          activeRunSummary={summaryForSelectedFeature}
          activeRunStatus={statusForSelectedFeature}
          onTotalTestsChange={setSpecTotalTests}
          dirtySpecs={features.find((f) => f.name === selectedFeature)?.dirty?.specs ?? []}
        />
      ),
    },
    {
      id: 'runs',
      minWidth: 400,
      defaultWidth: 500,
      collapsible: false,
      content: (
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
              /* Only over the suite the guide is talking about — the cue rings
                 the Run button, so it must not appear while a different suite
                 is selected. */
              guide={guide.step === 'run-suite' && selectedFeature === guide.suite ? (
                <FirstRunGuide step="run-suite" onDismiss={() => guide.dismiss('run-suite')} />
              ) : undefined}
              /* Same owner as the guide, and read straight from the server's
                 onboarding samples rather than a literal suite name — so it stays
                 correct if the shipped demo is ever renamed, and goes quiet once
                 the user deletes it. */
              sampleSuite={guide.suite}
            />
          )}
          bottom={(
            <RunDetailColumn
              runId={selectedRunId}
              onOpenPlaywrightSettings={(f) => setConfigFor(f, 'playwright')}
              totalTests={specTotalTests}
              /* Honoured only when the focus belongs to the run being shown, so a
                 stale pair from a previous selection can't scroll this one. */
              {...(focusTest && focusTest.runId === selectedRunId ? { focusTest: focusTest.test } : {})}
              /* Same pairing rule for the arrival tab a drill-through named. */
              {...(runTab && runTab.runId === selectedRunId ? { arriveTab: runTab.tab } : {})}
            />
          )}
        />
      ),
    },
  ]

  return (
    <div className="flex h-full w-full flex-col">
      <GlobalStatusBar
        activeRunDetail={activeRunDetail}
        features={features}
        onOpenCleanup={() => setView('cleanup')}
        flights={flights}
        preFlights={preFlights}
        onOpenPreFlight={(taskId) => { setResumePlanTaskId(taskId); setFlightStartNew(true) }}
        activity={featureActivity}
        derivedStages={derivedStages}
        onOpenFlight={openFlight}
        flightsPickerOpen={view === 'flights' && !selectedFlightId}
        onFlightsPickerOpenChange={(open) => {
          if (open) { setSelectedFlightId(null); setView('flights') }
          else setView('workspace')
        }}
        onOpenActivity={openActivity}
        onStartFlight={(feature) => { setSelectedFeature(feature); setFlightStartFor(feature) }}
        onNavigateToRun={(feature, runId) => navigateToRun(feature, runId)}
        returnFlight={returnFlight}
        returnFlightLabel={returnFlightLabel}
        onReturnToFlight={openFlight}
      />
      <div className="min-h-0 flex-1">
        {view === 'cleanup'
          ? <LogCleanupPage
              onClose={() => setView('workspace')}
              onNavigateToRun={(feature, runId) => navigateToRun(feature, runId)}
              onNavigateToPortify={(workflowId) => {
                setView('workspace')
                setPortifyTarget({ kind: 'revisit', workflowId })
              }}
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
            />
          : view === 'flights' && selectedFlightId
          ? <FlightPage
              flightId={selectedFlightId}
              activity={featureActivity}
              derivedStages={derivedStages}
              // Select the feature too: the config dialog is qualified by the
              // durable `feature` param, so opening it for a flight's feature
              // while a DIFFERENT one is selected would deep-link to the wrong
              // suite. Same alignment onStartFlight already does below.
              onOpenConfig={(feature, tab) => { setSelectedFeature(feature); setConfigFor(feature, tab ?? null) }}
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
            />
          : <ResizablePanels panels={panels} />}
      </div>
      <ToastHost toasts={toasts} onDismiss={dismissToast} />
      {(flightStartFor !== null || flightStartNew) && (
        <FlightStartDialog
          feature={flightStartNew ? null : flightStartFor}
          intent={flightStartFresh ? 'fresh' : 'refly'}
          fromStage={flightStartNew ? null : flightStartStage}
          resumePlanTaskId={flightStartNew ? resumePlanTaskId : null}
          newFlightPrefill={flightStartNew ? guideFlightPrefill : null}
          knownRepos={knownRepos}
          onClose={() => { setFlightStartFor(null); setFlightStartNew(false); setResumePlanTaskId(null); setGuideFlightPrefill(null) }}
          onOpenFlight={(flightId) => {
            setFlightStartFor(null)
            setFlightStartNew(false)
            setResumePlanTaskId(null)
            setGuideFlightPrefill(null)
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
          onStartPortify={(f) => setPortifyTarget({ kind: 'new', feature: f })}
          onOpenPortify={(workflowId) => setPortifyTarget({ kind: 'revisit', workflowId })}
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
      {collisionPrompt && (
        <CollisionConfirmDialog
          info={collisionPrompt.info}
          feature={collisionPrompt.feature}
          portsConfigured={collisionPrompt.portsConfigured}
          onPortify={() => { const f = collisionPrompt.feature; setCollisionPrompt(null); setPortifyTarget({ kind: 'new', feature: f }) }}
          onChoose={resolveCollision}
          onCancel={() => setCollisionPrompt(null)}
        />
      )}
      {startError && (
        <RunStartErrorDialog
          error={startError.error}
          feature={startError.feature}
          onRetry={() => {
            const { env, mode } = startError
            setStartError(null)
            void handleStartRun(env, mode)
          }}
          onSwitchBranches={switchBranchesAndRun}
          onPinCurrent={pinCurrentAndRun}
          onClose={() => setStartError(null)}
        />
      )}
      {portifyTarget && (
        <PortifyWizard
          // Key on the target identity so switching new→revisit (e.g. the blocked
          // Plan screen's "Open running workflow") remounts with fresh state —
          // workflowId is seeded from a prop via useState, which only runs at mount.
          key={portifyTarget.kind === 'new' ? `new:${portifyTarget.feature}` : `revisit:${portifyTarget.workflowId}`}
          {...(portifyTarget.kind === 'new'
            ? { feature: portifyTarget.feature, agent: 'claude' as const }
            : { workflowId: portifyTarget.workflowId })}
          onOpenActive={(workflowId) => setPortifyTarget({ kind: 'revisit', workflowId })}
          onClose={() => setPortifyTarget(null)}
          onSaved={() => {
            setPortifyTarget(null)
            // The overlay now exists — refresh /api/features so the "Portified"
            // badge + Ports-tab indicator reflect it immediately.
            refreshFeatures(selectedFeatureRef.current)
            // The overlay also rewrote the port slots; invalidate so the open
            // Ports tab refetches its config doc instead of waiting for a tab
            // switch / refresh. (features-changed alone only refreshes the list.)
            invalidate('ports')
          }}
        />
      )}
      {draftFor && (
        <DraftDialog draftId={draftFor} onClose={() => setDraftFor(null)} />
      )}
    </div>
  )
}
