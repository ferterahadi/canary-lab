import { useEffect, useState } from 'react'
import * as api from '../api/client'
import type { FeatureSpecFile, RunManifest } from '../api/types'
import type { TestSourceComparison } from '@shared/test-review'

type Baseline = Pick<RunManifest, 'runId' | 'featureDir' | 'suiteSnapshot'>
type Comparison = TestSourceComparison | { state: 'loading' | 'error'; differences: [] }

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
  const otherVersion = recordedView ? 'current' : 'recorded'
  useEffect(() => {
    if (!ready || !displayed) return
    setLists((previous) => ({ ...(previous?.key === contextKey ? previous : {}), key: contextKey, [visibleVersion]: { specs: displayed } }))
  }, [ready, displayed, contextKey, visibleVersion])
  useEffect(() => {
    if (!feature || !baseline?.runId) return
    let cancelled = false
    const save = (list: List) => {
      if (!cancelled) setLists((previous) => ({ ...(previous?.key === contextKey ? previous : {}), key: contextKey, [otherVersion]: list }))
    }
    api.getFeatureTests(feature, undefined, otherRunId).then((specs) => {
      save({ specs, failed: specs.some((spec) => Boolean(spec.discoveryError)) })
    }).catch(() => { save({ failed: true }) })
    return () => { cancelled = true }
  }, [feature, baseline?.runId, otherRunId, contextKey, otherVersion])
  const cached = lists?.key === contextKey ? lists : null
  const other = cached?.[otherVersion]
  const counterpart = !other?.failed ? other?.specs ?? null : null
  const visible = displayFailed ? null : ready ? displayed : cached?.[visibleVersion]?.specs ?? null
  const current = recordedView ? counterpart : visible
  const recorded = recordedView ? visible : counterpart
  const snapshotDir = baseline?.suiteSnapshot?.kind === 'taken' ? baseline.suiteSnapshot.dir : undefined
  const [comparison, setComparison] = useState<{ key: string; value: Comparison } | null>(null)
  useEffect(() => {
    if (!feature || !baseline?.runId || !snapshotDir) return
    let cancelled = false
    api.getTestSourceComparison(feature, baseline.runId).then((value) => {
      if (!cancelled) setComparison({ key: contextKey, value })
    }).catch(() => { if (!cancelled) setComparison({ key: contextKey, value: { state: 'error', differences: [] } }) })
    return () => { cancelled = true }
  }, [feature, baseline?.runId, snapshotDir, contextKey])
  const value: Comparison = !snapshotDir ? { state: 'unavailable', differences: [], files: [], reasons: ['Snapshot unavailable'] }
    : comparison?.key === contextKey ? comparison.value : { state: 'loading', differences: [] }
  return { current, recorded, comparison: value }
}
