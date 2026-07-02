import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FeaturesColumn } from './shared/shell/FeaturesColumn'
import { TestCasesColumn } from './shared/shell/TestCasesColumn'
import { RunsColumn } from './features/runs/components/RunsColumn'
import { RunDetailColumn } from './features/runs/components/RunDetailColumn'
import { FeatureConfigEditor } from './features/config/components/FeatureConfigEditor'
import { ResizablePanels } from './shared/ui/ResizablePanels'
import { VerticalSplit } from './shared/ui/VerticalSplit'
import { GlobalStatusBar } from './shared/shell/GlobalStatusBar'
import { AddTestWizard } from './features/wizard/components/AddTestWizard'
import { CollisionConfirmDialog } from './features/runs/components/CollisionConfirmDialog'
import { PortifyWizard } from './features/portify/components/PortifyWizard'
import { LogCleanupPage } from './features/logs/components/LogCleanupPage'
import { CoverageLedgerPage } from './features/coverage/components/CoverageLedgerPage'
import type { RepoCollisionChoice } from './shared/api/client'
import * as api from './shared/api/client'
import { connectWorkspaceEvents } from './features/runs/api/workspace-socket'
import { useRuns, useRun, useGlobalActiveRun } from './features/runs/state/RunsContext'
import { useWizardDrafts } from './features/wizard/state/WizardDraftContext'
import { useEvaluationExports } from './features/evaluation/state/EvaluationExportContext'
import type { Feature, VersionStatus } from './shared/api/types'
import { readPersistedView, persistView, onViewChangedInOtherTab } from './shared/lib/workspace-view-state'

// R12: hydrate the open view + selected feature from the URL/localStorage so a
// refresh or a second tab restores where you were, not a blank workspace.
const PERSISTED_VIEW = readPersistedView()

export function App() {
  const [features, setFeatures] = useState<Feature[]>([])
  const [selectedFeature, setSelectedFeature] = useState<string | null>(PERSISTED_VIEW.feature)
  // R24: hydrate the selected run from the URL so a deep-linked / refreshed run
  // reopens. The run loads async over the WS, so we also seed the pending ref
  // below to stop the stale-run guard from clearing it before runs arrive.
  const [selectedRunId, setSelectedRunId] = useState<string | null>(PERSISTED_VIEW.run)
  const [configFor, setConfigFor] = useState<string | null>(
    PERSISTED_VIEW.dialog === 'config' ? PERSISTED_VIEW.feature : null,
  )
  const [testsRefreshKey, setTestsRefreshKey] = useState(0)
  const [coverageRefreshKey, setCoverageRefreshKey] = useState(0)
  // Bumped when a portify overlay is saved — forces the open Ports tab to refetch
  // its config doc so the rewritten slots show without a tab switch / refresh.
  const [portsRefreshKey, setPortsRefreshKey] = useState(0)
  const [reposRefreshKey, setReposRefreshKey] = useState(0)
  const [verificationRefreshKey, setVerificationRefreshKey] = useState(0)
  const [journalRefreshKeys, setJournalRefreshKeys] = useState<Record<string, number>>({})
  const [specTotalTests, setSpecTotalTests] = useState(0)
  const [collisionPrompt, setCollisionPrompt] = useState<{ feature: string; env?: string; mode?: 'test' | 'boot'; info: RepoCollisionChoice; portsConfigured?: boolean } | null>(null)
  // Port-ification wizard target: 'new' starts a fresh workflow for a feature;
  // 'revisit' reopens an in-flight workflow (from the status bar) by id.
  // R24: hydrate from the URL — `wf` present = revisit, absent = start-new.
  const [portifyTarget, setPortifyTarget] = useState<
    { kind: 'new'; feature: string } | { kind: 'revisit'; workflowId: string } | null
  >(() => {
    if (PERSISTED_VIEW.dialog !== 'portify') return null
    if (PERSISTED_VIEW.wf) return { kind: 'revisit', workflowId: PERSISTED_VIEW.wf }
    if (PERSISTED_VIEW.feature) return { kind: 'new', feature: PERSISTED_VIEW.feature }
    return null
  })
  // R24: the Verify-config dialog (in the runs column) is route-driven too.
  const [verifyOpen, setVerifyOpen] = useState(PERSISTED_VIEW.dialog === 'verification')
  // Top-level view: the normal workspace, or a full-screen page (cleanup /
  // coverage). Hydrated from the URL/localStorage (R12) so it survives refresh.
  const [view, setView] = useState<'workspace' | 'cleanup' | 'coverage'>(PERSISTED_VIEW.view)
  // Current-vs-latest version + self-update job state. Sourced from the server,
  // refetched on every `version-changed` event (registry check resolved, or the
  // update job advanced) so the footer indicator updates live.
  const [versionStatus, setVersionStatus] = useState<VersionStatus | null>(null)
  const pendingRunSelectionRef = useRef<string | null>(PERSISTED_VIEW.run)
  const selectedFeatureRef = useRef<string | null>(null)
  const selectedRunIdRef = useRef<string | null>(PERSISTED_VIEW.run)

  // Runs come from the WebSocket-backed RunsProvider — no polling here.
  // `runs` is the full index across all features; the per-feature filter
  // happens at render time. Declared here (above the persist effect) because the
  // route serialization below reads `wizardOpen`.
  const { runs: allRuns, startRun: startRunAction, startVerification: startVerificationAction } = useRuns()
  // Read inside refreshFeatures via ref, not closure — allRuns changes on every
  // run-progress tick, and closing over it directly would give refreshFeatures a
  // new identity each time, which would tear down and reopen the /ws/workspace
  // socket below (its connect effect depends on refreshFeatures) on every tick.
  // The bus has no replay, so any event published during that reconnect window
  // is lost — exactly the "only updates after a refresh" failure mode.
  const allRunsRef = useRef(allRuns)
  useEffect(() => { allRunsRef.current = allRuns }, [allRuns])
  const { entry: globalActiveRunEntry, detail: activeRunDetail } = useGlobalActiveRun()
  const { wizardOpen, closeWizard, startNewWizard } = useWizardDrafts()
  // R24: the evaluation export dialog's open-state lives in EvaluationExportContext
  // (mounted in the status bar). Read it here — above the persist effect — so the
  // route serializes it, and seed it from the URL on first load below.
  const { dialogOpen: evaluationOpen, selectedTask: evaluationTask, openTask: openEvaluationTask } = useEvaluationExports()

  // R12/R24: persist the full route (view + feature + selected run + open routed
  // dialog) to the URL on every change so a refresh / deep link restores it. The
  // durable tier (view + feature) also mirrors to localStorage for cross-tab sync.
  // Dialog precedence follows z-order: the full-screen overlays (portify > config
  // > wizard) sit above the in-column verify dialog, so the topmost open one owns
  // the URL.
  const routedDialog = portifyTarget ? 'portify' : configFor ? 'config' : wizardOpen ? 'add-test' : verifyOpen ? 'verification' : evaluationOpen ? 'evaluation' : null
  const routedWf = portifyTarget?.kind === 'revisit' ? portifyTarget.workflowId : null
  const routedTask = evaluationOpen ? evaluationTask?.taskId ?? null : null
  useEffect(() => {
    persistView({ view, feature: selectedFeature, run: selectedRunId, dialog: routedDialog, wf: routedWf, task: routedTask })
  }, [view, selectedFeature, selectedRunId, routedDialog, routedWf, routedTask])

  // R24: the Add-Test wizard and the evaluation export dialog keep their open-state
  // in a context, not PERSISTED_VIEW-seeded local state — so reopen them from the
  // URL on first load.
  useEffect(() => {
    if (PERSISTED_VIEW.dialog === 'add-test') startNewWizard()
    if (PERSISTED_VIEW.dialog === 'evaluation') openEvaluationTask(PERSISTED_VIEW.task ?? undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => onViewChangedInOtherTab((s) => {
    setView(s.view)
    if (s.feature) setSelectedFeature(s.feature)
  }), [])

  // Initial features load + auto-select first feature.
  useEffect(() => {
    let cancelled = false
    api.listFeatures().then((data) => {
      if (cancelled) return
      setFeatures(data)
      if (data.length > 0 && !selectedFeature) setSelectedFeature(data[0].name)
    }).catch(() => {})
    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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

  const handleStartRun = useCallback(async (env?: string, mode: 'test' | 'boot' = 'test'): Promise<void> => {
    if (!selectedFeature) return
    // Concurrent runs are allowed: different apps run in parallel on distinct
    // allocated ports; the backend admits or queues as resources allow. A
    // same-repo collision comes back as a 409 — prompt the user to isolate or
    // queue, then re-issue with their choice (preserving the boot/test mode).
    try {
      const runId = await startRunAction(selectedFeature, env, undefined, mode)
      // Boot sessions are managed in the global Services overlay, never column
      // 3 — don't select them into the run-detail pane.
      if (mode !== 'boot') {
        pendingRunSelectionRef.current = runId
        setSelectedRunId(runId)
      }
    } catch (err) {
      const collision = api.asRepoCollision(err)
      if (collision) {
        // A collision means a second concurrent run of the same app — the one
        // case where hardcoded ports actually clash. Check whether ports are
        // injectable so the dialog can offer the durable fix alongside
        // worktree/queue. Best-effort: the dialog still works without the flag.
        let portsConfigured: boolean | undefined
        try { portsConfigured = (await api.benchmarkPreflight(selectedFeature, env)).portsConfigured } catch { /* ignore */ }
        setCollisionPrompt({ feature: selectedFeature, env, mode, info: collision, portsConfigured })
        return
      }
      /* other errors surfaced via UI */
    }
  }, [selectedFeature, startRunAction])

  const resolveCollision = useCallback(async (isolation: 'worktree' | 'queue'): Promise<void> => {
    const prompt = collisionPrompt
    setCollisionPrompt(null)
    if (!prompt) return
    try {
      const runId = await startRunAction(prompt.feature, prompt.env, isolation, prompt.mode)
      if (prompt.mode !== 'boot') {
        pendingRunSelectionRef.current = runId
        setSelectedRunId(runId)
      }
    } catch { /* surfaced via UI */ }
  }, [collisionPrompt, startRunAction])

  const handleStartVerification = useCallback(async (input: {
    configId?: string
    targetUrls?: Record<string, string>
    playwrightEnvsetId?: string
  }): Promise<void> => {
    if (!selectedFeature) return
    const runId = await startVerificationAction(selectedFeature, input)
    pendingRunSelectionRef.current = runId
    setSelectedRunId(runId)
  }, [selectedFeature, startVerificationAction])

  // Stable identity ([] deps) — reads the current feature/runs via refs rather
  // than closing over the `selectedFeature`/`allRuns` state directly, so callers
  // that depend on this function (the /ws/workspace connect effect below) don't
  // reconnect on every unrelated run-progress tick. See the allRunsRef comment.
  const refreshFeatures = useCallback((preferredFeature?: string | null): void => {
    api.listFeatures().then((data) => {
      setFeatures(data)
      const runs = allRunsRef.current
      if (preferredFeature && data.some((f) => f.name === preferredFeature)) {
        pendingRunSelectionRef.current = null
        setSelectedFeature(preferredFeature)
        setSelectedRunId(runs.find((r) => r.feature === preferredFeature && r.executionType !== 'boot' && r.executionType !== 'benchmark')?.runId ?? null)
      } else if (!selectedFeatureRef.current || !data.some((f) => f.name === selectedFeatureRef.current)) {
        const nextFeature = data[0]?.name ?? null
        pendingRunSelectionRef.current = null
        setSelectedFeature(nextFeature)
        setSelectedRunId(nextFeature ? runs.find((r) => r.feature === nextFeature && r.executionType !== 'boot' && r.executionType !== 'benchmark')?.runId ?? null : null)
      }
    }).catch(() => {})
  }, [])

  const refreshVersion = useCallback((): void => {
    api.getVersionStatus().then(setVersionStatus).catch(() => {})
  }, [])

  // Initial version check on mount.
  useEffect(() => { refreshVersion() }, [refreshVersion])

  useEffect(() => {
    selectedFeatureRef.current = selectedFeature
  }, [selectedFeature])

  useEffect(() => {
    selectedRunIdRef.current = selectedRunId
  }, [selectedRunId])

  useEffect(() => {
    let conn: { close(): void } | null = null
    try {
      conn = connectWorkspaceEvents({
        onEvent: (event) => {
          if (event.type === 'feature-created' || event.type === 'feature-deleted' || event.type === 'features-changed') {
            refreshFeatures(event.type === 'feature-created' ? event.feature : undefined)
            // A branch checkout (and other feature mutations) emits features-changed;
            // bump so an open Repos tab refetches its git-status row live.
            if (event.type === 'features-changed') setReposRefreshKey((key) => key + 1)
            return
          }
          if (event.type === 'tests-changed' && selectedFeatureRef.current === event.feature) {
            setTestsRefreshKey((key) => key + 1)
          }
          if (event.type === 'envsets-changed') {
            refreshFeatures(selectedFeatureRef.current)
          }
          if (event.type === 'coverage-changed') {
            setCoverageRefreshKey((key) => key + 1)
          }
          if (event.type === 'tests-dirty-changed') {
            // Dirty status is folded into the feature-list payload — refetch it
            // so the red cue + status pill update live (preserves selection).
            refreshFeatures(selectedFeatureRef.current)
          }
          if (event.type === 'verification-config-changed' && selectedFeatureRef.current === event.feature) {
            setVerificationRefreshKey((key) => key + 1)
          }
          if (event.type === 'journal-changed') {
            setJournalRefreshKeys((keys) => ({ ...keys, [event.runId]: (keys[event.runId] ?? 0) + 1 }))
          }
          if (event.type === 'version-changed') {
            refreshVersion()
          }
        },
        // The bus has no replay, so any mutation that happened while the socket
        // was down (e.g. across a canary-apply server restart) was never
        // pushed. Resync the feature-derived surfaces on reconnect rather than
        // waiting for the next live event.
        onReconnect: () => {
          refreshFeatures(selectedFeatureRef.current)
          setReposRefreshKey((key) => key + 1)
          setTestsRefreshKey((key) => key + 1)
          setCoverageRefreshKey((key) => key + 1)
          setVerificationRefreshKey((key) => key + 1)
          const currentRunId = selectedRunIdRef.current
          if (currentRunId) {
            setJournalRefreshKeys((keys) => ({ ...keys, [currentRunId]: (keys[currentRunId] ?? 0) + 1 }))
          }
          refreshVersion()
        },
      })
    } catch {
      // Initial REST load and direct UI callbacks still keep the page usable.
    }
    return () => conn?.close()
  }, [refreshFeatures, refreshVersion])

  const selectedFeatureEnvs =
    features.find((f) => f.name === selectedFeature)?.envs ?? []

  const panels = [
    {
      id: 'features',
      minWidth: 180,
      defaultWidth: 220,
      collapsible: true,
      collapseButtonY: 'top' as const,
      content: (
        <FeaturesColumn
          features={features}
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
          coverageRefreshKey={coverageRefreshKey}
          portsRefreshKey={portsRefreshKey}
          versionStatus={versionStatus}
          onStartPortify={(f) => setPortifyTarget({ kind: 'new', feature: f })}
          onOpenPortify={(workflowId) => setPortifyTarget({ kind: 'revisit', workflowId })}
          onOpenCoverage={(f) => { setSelectedFeature(f); setView('coverage') }}
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
          refreshKey={testsRefreshKey}
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
              verificationRefreshKey={verificationRefreshKey}
            />
          )}
          bottom={<RunDetailColumn runId={selectedRunId} onOpenPlaywrightSettings={setConfigFor} totalTests={specTotalTests} journalRefreshKey={selectedRunId ? journalRefreshKeys[selectedRunId] ?? 0 : 0} />}
        />
      ),
    },
  ]

  return (
    <div className="flex h-full w-full flex-col">
      <GlobalStatusBar
        activeRunDetail={activeRunDetail}
        features={features}
        onNavigateToRun={(feature, runId) => {
          pendingRunSelectionRef.current = null
          setSelectedFeature(feature)
          setSelectedRunId(runId)
          setView('workspace')
        }}
        onOpenCleanup={() => setView('cleanup')}
        onOpenCoverage={(feature) => { setSelectedFeature(feature); setView('coverage') }}
        onStartPortify={(f) => setPortifyTarget({ kind: 'new', feature: f })}
        onOpenPortify={(workflowId) => setPortifyTarget({ kind: 'revisit', workflowId })}
      />
      <div className="min-h-0 flex-1">
        {view === 'cleanup'
          ? <LogCleanupPage
              onClose={() => setView('workspace')}
              onNavigateToRun={(feature, runId) => {
                pendingRunSelectionRef.current = null
                setSelectedFeature(feature)
                setSelectedRunId(runId)
                setView('workspace')
              }}
              onNavigateToPortify={(workflowId) => {
                setView('workspace')
                setPortifyTarget({ kind: 'revisit', workflowId })
              }}
            />
          : view === 'coverage' && selectedFeature
          ? <CoverageLedgerPage feature={selectedFeature} onClose={() => setView('workspace')} coverageRefreshKey={coverageRefreshKey} />
          : <ResizablePanels panels={panels} />}
      </div>
      {configFor && (
        <FeatureConfigEditor
          feature={configFor}
          initialTab="playwright"
          portsRefreshKey={portsRefreshKey}
          reposRefreshKey={reposRefreshKey}
          onStartPortify={(f) => setPortifyTarget({ kind: 'new', feature: f })}
          onOpenPortify={(workflowId) => setPortifyTarget({ kind: 'revisit', workflowId })}
          onClose={() => setConfigFor(null)}
          onRenamed={(_, nextFeature) => {
            setConfigFor(nextFeature)
            api.listFeatures().then((data) => {
              setFeatures(data)
              pendingRunSelectionRef.current = null
              setSelectedFeature(nextFeature)
              setSelectedRunId(allRuns.find((r) => r.feature === nextFeature && r.executionType !== 'boot' && r.executionType !== 'benchmark')?.runId ?? null)
            }).catch(() => {})
          }}
          onDeleted={(deletedFeature) => {
            setConfigFor(null)
            api.listFeatures().then((data) => {
              setFeatures(data)
              if (selectedFeature === deletedFeature) {
                const nextFeature = data[0]?.name ?? null
                pendingRunSelectionRef.current = null
                setSelectedFeature(nextFeature)
                setSelectedRunId(nextFeature ? allRuns.find((r) => r.feature === nextFeature && r.executionType !== 'boot' && r.executionType !== 'benchmark')?.runId ?? null : null)
              }
            }).catch(() => {})
          }}
        />
      )}
      {wizardOpen && (
        <AddTestWizard
          features={features}
          onClose={closeWizard}
          onAcceptedFeature={(feature) => refreshFeatures(feature)}
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
            // The overlay also rewrote the port slots; bump the key so the open
            // Ports tab refetches its config doc instead of waiting for a tab
            // switch / refresh. (features-changed alone only refreshes the list.)
            setPortsRefreshKey((key) => key + 1)
          }}
        />
      )}
    </div>
  )
}
