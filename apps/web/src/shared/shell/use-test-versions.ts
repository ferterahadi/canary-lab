import { useEffect, useState } from 'react'
import { useFeatureTestRoster } from '../state/use-feature-test-roster'
import type { FeatureSpecFile } from '../api/types'
import type { RunManifest } from '@shared/run-manifest'
import { useTestSourceComparison } from '../state/use-test-source-comparison'

type Baseline = Pick<RunManifest, 'runId' | 'featureDir' | 'suiteSnapshot'>

/** The card loader owns the visible roster; fetch its counterpart for totals.
 * Declaration changes come from source snapshots independently of either roster. */
export function useTestVersions({ feature, baseline, displayed, recordedView, revision, ready, displayFailed }: {
  feature: string | null
  baseline: Baseline | undefined
  displayed: FeatureSpecFile[] | null
  recordedView: boolean
  revision: string
  ready: boolean
  displayFailed: boolean
}) {
  const otherRunId = recordedView ? undefined : baseline?.runId
  const contextKey = JSON.stringify([feature, baseline?.runId, baseline?.featureDir, baseline?.suiteSnapshot, revision])
  type List = { specs?: FeatureSpecFile[]; failed?: boolean }
  const [lists, setLists] = useState<{ key: string; current?: List; recorded?: List } | null>(null)
  const visibleVersion = recordedView ? 'recorded' : 'current'
  useEffect(() => {
    if (!ready || !displayed) return
    setLists((previous) => ({ ...(previous?.key === contextKey ? previous : {}), key: contextKey, [visibleVersion]: { specs: displayed } }))
  }, [ready, displayed, contextKey, visibleVersion])
  const other = useFeatureTestRoster({ feature, runId: otherRunId, enabled: Boolean(baseline?.runId), refreshKey: contextKey })
  const cached = lists?.key === contextKey ? lists : null
  const counterpart = !other.failure ? other.specs : null
  const visible = displayFailed ? null : ready ? displayed : cached?.[visibleVersion]?.specs ?? null
  const current = recordedView ? counterpart : visible
  const recorded = recordedView ? visible : counterpart
  const snapshotDir = baseline?.suiteSnapshot?.kind === 'taken' ? baseline.suiteSnapshot.dir : null
  const source = useTestSourceComparison({
    feature, runId: baseline?.runId, featureDir: baseline?.featureDir, snapshotDir, refreshKey: revision,
  })
  const comparison = source.comparison
  // Retain the file evidence while withdrawing actionable header counts after
  // an edit or failed read; the previous declaration locations may be obsolete.
  const comparisonForHeader = comparison.state === 'ready' && !source.confirmed
    ? { state: source.error ? 'error' as const : 'loading' as const, files: [], differences: [] as [] }
    : comparison
  return { current, recorded, comparison, comparisonForHeader }
}
