import { useCallback, useEffect, useMemo, useState } from 'react'
import { FeaturesColumn } from './components/FeaturesColumn'
import { TestCasesColumn } from './components/TestCasesColumn'
import { RunsColumn } from './components/RunsColumn'
import { RunDetailColumn } from './components/RunDetailColumn'
import { ResizablePanels } from './components/ResizablePanels'
import { VerticalSplit } from './components/VerticalSplit'
import { GlobalStatusBar } from './components/GlobalStatusBar'
import * as api from './api/client'
import type { Feature, RunIndexEntry, RunDetail, RunSummary } from './api/types'

export function App() {
  const [features, setFeatures] = useState<Feature[]>([])
  const [selectedFeature, setSelectedFeature] = useState<string | null>(null)
  const [allRuns, setAllRuns] = useState<RunIndexEntry[]>([])
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [activeRunSummary, setActiveRunSummary] = useState<RunSummary | undefined>(undefined)
  const [activeRunDetail, setActiveRunDetail] = useState<RunDetail | null>(null)

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

  // Single source of truth: poll ALL runs globally. Per-feature filtering
  // happens in render; the active-run lookup also reads from this list.
  useEffect(() => {
    let cancelled = false
    const fetchRuns = (): void => {
      api.listRuns().then((data) => {
        if (cancelled) return
        setAllRuns(data)
      }).catch(() => {})
    }
    fetchRuns()
    const id = setInterval(fetchRuns, 5000)
    return () => { cancelled = true; clearInterval(id) }
  }, [])

  // Globally-active run (running OR healing). At most one at a time — used
  // to drive the global status bar AND to disable Run Now while it's busy.
  const globalActiveRun = useMemo(
    () => allRuns.find((r) => r.status === 'running' || r.status === 'healing') ?? null,
    [allRuns],
  )

  // Poll the active run's detail (manifest + summary). Drives the status bar
  // and the column-2 test status pills (when the active run matches the
  // selected feature).
  useEffect(() => {
    if (!globalActiveRun) {
      setActiveRunSummary(undefined)
      setActiveRunDetail(null)
      return
    }
    let cancelled = false
    const tick = (): void => {
      api.getRunDetail(globalActiveRun.runId).then((data) => {
        if (cancelled) return
        setActiveRunSummary(data.summary)
        setActiveRunDetail(data)
      }).catch(() => {})
    }
    tick()
    const id = setInterval(tick, 3000)
    return () => { cancelled = true; clearInterval(id) }
  }, [globalActiveRun])

  // Column 3 lists runs scoped to the currently-selected feature.
  const featureRuns = useMemo(
    () => allRuns.filter((r) => r.feature === selectedFeature),
    [allRuns, selectedFeature],
  )

  // Column 2 only shows live status pills when the active run matches the
  // selected feature; otherwise tests for an unrelated feature would appear
  // "passed" or "failed" based on a different run's summary.
  const summaryForSelectedFeature: RunSummary | undefined =
    globalActiveRun && globalActiveRun.feature === selectedFeature ? activeRunSummary : undefined

  const handleStartRun = useCallback(async (env?: string): Promise<void> => {
    if (!selectedFeature) return
    if (globalActiveRun) return // single-run constraint
    try {
      const { runId } = await api.startRun(selectedFeature, env ? { env } : undefined)
      setSelectedRunId(runId)
      const data = await api.listRuns()
      setAllRuns(data)
    } catch { /* surfaced via UI */ }
  }, [selectedFeature, globalActiveRun])

  const selectedFeatureEnvs =
    features.find((f) => f.name === selectedFeature)?.envs ?? []

  const panels = [
    {
      id: 'features',
      minWidth: 180,
      defaultWidth: 220,
      collapsible: true,
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
              runDisabled={Boolean(globalActiveRun)}
              runDisabledReason={
                globalActiveRun
                  ? `Another run is ${globalActiveRun.status} (${globalActiveRun.feature}). Stop it first.`
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
