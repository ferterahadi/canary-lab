import { useCallback, useEffect, useState } from 'react'
import { FeaturesColumn } from './components/FeaturesColumn'
import { RunsColumn } from './components/RunsColumn'
import { RunDetailColumn } from './components/RunDetailColumn'
import * as api from './api/client'
import type { Feature, RunIndexEntry } from './api/types'

// Three-column Finder-style shell. Each column owns its own data fetching;
// the App component just tracks the selection state.
export function App(): JSX.Element {
  const [features, setFeatures] = useState<Feature[]>([])
  const [selectedFeature, setSelectedFeature] = useState<string | null>(null)
  const [runs, setRuns] = useState<RunIndexEntry[]>([])
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)

  // Initial load of features.
  useEffect(() => {
    let cancelled = false
    api.listFeatures().then((data) => {
      if (cancelled) return
      setFeatures(data)
      if (data.length > 0 && !selectedFeature) setSelectedFeature(data[0].name)
    }).catch(() => { /* swallow — surfaced via empty state */ })
    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Refresh runs whenever the selected feature changes; poll every 5s.
  useEffect(() => {
    if (!selectedFeature) {
      setRuns([])
      return
    }
    let cancelled = false
    const fetchRuns = (): void => {
      api.listRuns({ feature: selectedFeature }).then((data) => {
        if (cancelled) return
        setRuns(data)
      }).catch(() => { /* keep last data on error */ })
    }
    fetchRuns()
    const id = setInterval(fetchRuns, 5000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [selectedFeature])

  const handleStartRun = useCallback(async (): Promise<void> => {
    if (!selectedFeature) return
    try {
      const { runId } = await api.startRun(selectedFeature)
      setSelectedRunId(runId)
      const data = await api.listRuns({ feature: selectedFeature })
      setRuns(data)
    } catch {
      /* surfaced via UI later */
    }
  }, [selectedFeature])

  return (
    <div className="flex h-full w-full overflow-hidden">
      <aside className="w-[240px] shrink-0 border-r border-zinc-800 overflow-y-auto">
        <FeaturesColumn
          features={features}
          selectedFeature={selectedFeature}
          onSelectFeature={(name) => {
            setSelectedFeature(name)
            setSelectedRunId(null)
          }}
          onFeaturesChanged={(acceptedFeature) => {
            // Refresh after the wizard creates a new feature so it appears
            // in the sidebar; auto-select it if provided.
            api.listFeatures().then((data) => {
              setFeatures(data)
              if (acceptedFeature && data.some((f) => f.name === acceptedFeature)) {
                setSelectedFeature(acceptedFeature)
                setSelectedRunId(null)
              }
            }).catch(() => { /* keep prior list on error */ })
          }}
        />
      </aside>
      <section className="w-[320px] shrink-0 border-r border-zinc-800 overflow-y-auto">
        <RunsColumn
          feature={selectedFeature}
          runs={runs}
          selectedRunId={selectedRunId}
          onSelectRun={setSelectedRunId}
          onStartRun={handleStartRun}
        />
      </section>
      <main className="flex-1 min-w-0 overflow-hidden">
        <RunDetailColumn runId={selectedRunId} />
      </main>
    </div>
  )
}
