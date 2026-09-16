import { useEffect, useState } from 'react'
import * as api from '../api/client'
import type { FeatureSpecFile, RunManifest } from '../api/types'
import { compareTestVersions, suiteRelativeFile, type RunDifference } from '../lib/test-versions'

type Baseline = Pick<RunManifest, 'runId' | 'featureDir' | 'suiteSnapshot'>
type Comparison =
  | { state: 'loading' | 'unavailable' | 'error'; differences: RunDifference[] }
  | { state: 'ready'; differences: RunDifference[]; files: string[]; changes: ReturnType<typeof compareTestVersions> }

/** The card loader owns the visible version; fetch only its counterpart here.
 * Both lists must belong to this selection/revision before comparing them. */
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
  const featureDir = baseline?.featureDir
  const rosterKey = JSON.stringify([current?.map((spec) => [spec.file, spec.tests.map((test) => [test.name, test.line])]), recorded?.map((spec) => [spec.file, spec.tests.map((test) => [test.name, test.line])])])
  const comparisonKey = JSON.stringify([contextKey, snapshotDir, featureDir, rosterKey])
  const [comparison, setComparison] = useState<{ key: string; value: Comparison } | null>(null)
  useEffect(() => {
    if (!feature || !baseline || !snapshotDir || !current || !recorded) return
    let cancelled = false
    const roots = [featureDir, snapshotDir]
    const files = [...new Set([...current, ...recorded].map((spec) => suiteRelativeFile(spec.file, ...roots)))].sort()
    Promise.all(files.map(async (file) => ({ file, ...await api.getTestFileDifference(feature, file, baseline.runId) }))).then((reviews) => {
      if (cancelled) return
      const differences = reviews.filter((review) => review.changed).map((review) => ({ file: review.file, affectedTests: review.affectedTests ?? [] }))
      const incomplete = [...current, ...recorded].some((spec) => spec.parseError || spec.discoveryError || spec.recordedSourceUnavailable)
      setComparison({ key: comparisonKey, value: incomplete ? { state: 'unavailable', differences } : {
        state: 'ready', differences, files, changes: compareTestVersions(current, recorded, roots, differences),
      } })
    }).catch(() => { if (!cancelled) setComparison({ key: comparisonKey, value: { state: 'error', differences: [] } }) })
    return () => { cancelled = true }
    // The key carries both complete rosters; stable array identities are not
    // required when the visible loader refreshes the same source.
  }, [feature, baseline?.runId, snapshotDir, featureDir, comparisonKey])
  const value: Comparison = !snapshotDir ? { state: 'unavailable', differences: [] }
    : displayFailed || other?.failed ? { state: 'error', differences: [] }
      : comparison?.key === comparisonKey ? comparison.value : { state: 'loading', differences: [] }
  return { current, recorded, comparison: value }
}
