import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FeaturesColumn } from './components/FeaturesColumn'
import { TestCasesColumn } from './components/TestCasesColumn'
import { RunsColumn } from './components/RunsColumn'
import { RunDetailColumn } from './components/RunDetailColumn'
import { ResizablePanels } from './components/ResizablePanels'
import { VerticalSplit } from './components/VerticalSplit'
import { GlobalStatusBar } from './components/GlobalStatusBar'
import * as api from './api/client'
import { useRuns, useRun, useGlobalActiveRun } from './state/RunsContext'
import type { Feature } from './api/types'

export function App() {
  const [features, setFeatures] = useState<Feature[]>([])
  const [selectedFeature, setSelectedFeature] = useState<string | null>(null)
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const pendingRunSelectionRef = useRef<string | null>(null)

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
  const { runs: allRuns, startRun: startRunAction } = useRuns()
  const { entry: globalActiveRunEntry, detail: activeRunDetail } = useGlobalActiveRun()

  // Column 3 lists runs scoped to the currently-selected feature.
  const featureRuns = useMemo(
    () => allRuns.filter((r) => r.feature === selectedFeature),
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

  const handleStartRun = useCallback(async (env?: string): Promise<void> => {
    if (!selectedFeature) return
    if (globalActiveRunEntry) return // single-run constraint
    try {
      const runId = await startRunAction(selectedFeature, env)
      pendingRunSelectionRef.current = runId
      setSelectedRunId(runId)
    } catch { /* surfaced via UI */ }
  }, [selectedFeature, globalActiveRunEntry, startRunAction])

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
          onSelectFeature={(name) => {
            pendingRunSelectionRef.current = null
            setSelectedFeature(name)
            setSelectedRunId(allRuns.find((r) => r.feature === name)?.runId ?? null)
          }}
          onFeaturesChanged={(acceptedFeature) => {
            api.listFeatures().then((data) => {
              setFeatures(data)
              if (acceptedFeature && data.some((f) => f.name === acceptedFeature)) {
                pendingRunSelectionRef.current = null
                setSelectedFeature(acceptedFeature)
                setSelectedRunId(allRuns.find((r) => r.feature === acceptedFeature)?.runId ?? null)
              }
            }).catch(() => {})
          }}
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
              runDisabled={Boolean(globalActiveRunEntry)}
              runDisabledReason={
                globalActiveRunEntry
                  ? `Another run is ${globalActiveRunEntry.status} (${globalActiveRunEntry.feature}). Stop it first.`
                  : undefined
              }
            />
          )}
          bottom={<RunDetailColumn runId={selectedRunId} />}
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
    </div>
  )
}
