import { useCallback, useEffect, useMemo, useState } from 'react'
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
  // Used to drive Column 2's per-test status pills so they persist past the
  // run's end.
  const latestRunForFeature = featureRuns[0] ?? null

  // The detail (and therefore the summary) for the latest run lives in the
  // shared store, populated by WS push frames. No separate poll.
  const latestDetail = useRun(latestRunForFeature?.runId ?? null)
  const summaryForSelectedFeature = latestDetail.detail?.summary

  const handleStartRun = useCallback(async (env?: string): Promise<void> => {
    if (!selectedFeature) return
    if (globalActiveRunEntry) return // single-run constraint
    try {
      const runId = await startRunAction(selectedFeature, env)
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
            setSelectedFeature(name)
            setSelectedRunId(null)
          }}
          onFeaturesChanged={(acceptedFeature) => {
            api.listFeatures().then((data) => {
              setFeatures(data)
              if (acceptedFeature && data.some((f) => f.name === acceptedFeature)) {
                setSelectedFeature(acceptedFeature)
                setSelectedRunId(null)
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
