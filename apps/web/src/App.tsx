import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FeaturesColumn } from './components/FeaturesColumn'
import { TestCasesColumn } from './components/TestCasesColumn'
import { RunsColumn } from './components/RunsColumn'
import { RunDetailColumn } from './components/RunDetailColumn'
import { FeatureConfigEditor } from './components/FeatureConfigEditor'
import { ResizablePanels } from './components/ResizablePanels'
import { VerticalSplit } from './components/VerticalSplit'
import { GlobalStatusBar } from './components/GlobalStatusBar'
import { AddTestWizard } from './components/AddTestWizard'
import { CollisionConfirmDialog } from './components/CollisionConfirmDialog'
import type { RepoCollisionChoice } from './api/client'
import * as api from './api/client'
import { connectWorkspaceEvents } from './api/workspace-socket'
import { useRuns, useRun, useGlobalActiveRun } from './state/RunsContext'
import { useWizardDrafts } from './state/WizardDraftContext'
import type { Feature } from './api/types'

export function App() {
  const [features, setFeatures] = useState<Feature[]>([])
  const [selectedFeature, setSelectedFeature] = useState<string | null>(null)
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [configFor, setConfigFor] = useState<string | null>(null)
  const [testsRefreshKey, setTestsRefreshKey] = useState(0)
  const [collisionPrompt, setCollisionPrompt] = useState<{ feature: string; env?: string; mode?: 'test' | 'boot'; info: RepoCollisionChoice } | null>(null)
  const pendingRunSelectionRef = useRef<string | null>(null)
  const selectedFeatureRef = useRef<string | null>(null)

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

  // Runs come from the WebSocket-backed RunsProvider — no polling here.
  // `runs` is the full index across all features; the per-feature filter
  // happens at render time.
  const { runs: allRuns, startRun: startRunAction, startVerification: startVerificationAction } = useRuns()
  const { entry: globalActiveRunEntry, detail: activeRunDetail } = useGlobalActiveRun()
  const { wizardOpen, closeWizard } = useWizardDrafts()

  // Column 3 lists runs scoped to the currently-selected feature. Boot-only
  // sessions are excluded — they're not test runs and live in the global
  // Services surface, not the Runs list.
  const featureRuns = useMemo(
    () => allRuns.filter((r) => r.feature === selectedFeature && r.executionType !== 'boot'),
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
      pendingRunSelectionRef.current = runId
      setSelectedRunId(runId)
    } catch (err) {
      const collision = api.asRepoCollision(err)
      if (collision) {
        setCollisionPrompt({ feature: selectedFeature, env, mode, info: collision })
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
      pendingRunSelectionRef.current = runId
      setSelectedRunId(runId)
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

  const refreshFeatures = useCallback((preferredFeature?: string | null): void => {
    api.listFeatures().then((data) => {
      setFeatures(data)
      if (preferredFeature && data.some((f) => f.name === preferredFeature)) {
        pendingRunSelectionRef.current = null
        setSelectedFeature(preferredFeature)
        setSelectedRunId(allRuns.find((r) => r.feature === preferredFeature)?.runId ?? null)
      } else if (!selectedFeature || !data.some((f) => f.name === selectedFeature)) {
        const nextFeature = data[0]?.name ?? null
        pendingRunSelectionRef.current = null
        setSelectedFeature(nextFeature)
        setSelectedRunId(nextFeature ? allRuns.find((r) => r.feature === nextFeature)?.runId ?? null : null)
      }
    }).catch(() => {})
  }, [allRuns, selectedFeature])

  useEffect(() => {
    selectedFeatureRef.current = selectedFeature
  }, [selectedFeature])

  useEffect(() => {
    let conn: { close(): void } | null = null
    try {
      conn = connectWorkspaceEvents({
        onEvent: (event) => {
          if (event.type === 'feature-created' || event.type === 'feature-deleted' || event.type === 'features-changed') {
            refreshFeatures(event.type === 'feature-created' ? event.feature : undefined)
            return
          }
          if (event.type === 'tests-changed' && selectedFeatureRef.current === event.feature) {
            setTestsRefreshKey((key) => key + 1)
          }
          if (event.type === 'envsets-changed') {
            refreshFeatures(selectedFeatureRef.current)
          }
        },
      })
    } catch {
      // Initial REST load and direct UI callbacks still keep the page usable.
    }
    return () => conn?.close()
  }, [refreshFeatures])

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
            setSelectedRunId(allRuns.find((r) => r.feature === name)?.runId ?? null)
          }}
          onFeaturesChanged={refreshFeatures}
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
          storageKey="canary-lab.runs-detail-split"
          defaultTopPercent={42}
          minTopPx={120}
          minBottomPx={160}
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
            />
          )}
          bottom={<RunDetailColumn runId={selectedRunId} onOpenPlaywrightSettings={setConfigFor} />}
        />
      ),
    },
  ]

  return (
    <div className="flex h-full w-full flex-col">
      <GlobalStatusBar
        activeRunDetail={activeRunDetail}
        onNavigateToRun={(feature, runId) => {
          pendingRunSelectionRef.current = null
          setSelectedFeature(feature)
          setSelectedRunId(runId)
        }}
      />
      <div className="min-h-0 flex-1">
        <ResizablePanels panels={panels} />
      </div>
      {configFor && (
        <FeatureConfigEditor
          feature={configFor}
          initialTab="playwright"
          onClose={() => setConfigFor(null)}
          onRenamed={(_, nextFeature) => {
            setConfigFor(nextFeature)
            api.listFeatures().then((data) => {
              setFeatures(data)
              pendingRunSelectionRef.current = null
              setSelectedFeature(nextFeature)
              setSelectedRunId(allRuns.find((r) => r.feature === nextFeature)?.runId ?? null)
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
                setSelectedRunId(nextFeature ? allRuns.find((r) => r.feature === nextFeature)?.runId ?? null : null)
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
          onChoose={resolveCollision}
          onCancel={() => setCollisionPrompt(null)}
        />
      )}
    </div>
  )
}
