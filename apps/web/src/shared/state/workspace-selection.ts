import type { RunIndexEntry } from '../api/types'
import { isAuxiliaryExecution } from '@shared/verification'

type FeatureNames = readonly { name: string }[]

export function workspaceRunsForFeature(runs: readonly RunIndexEntry[], feature: string | null): RunIndexEntry[] {
  return runs.filter((run) => run.feature === feature && !isAuxiliaryExecution(run.executionType))
}

export function latestFeatureRunId(runs: readonly RunIndexEntry[], feature: string | null): string | null {
  return workspaceRunsForFeature(runs, feature)[0]?.runId ?? null
}

export function initialFeatureSelection(features: FeatureNames, initialFeature: string | null): string | null {
  return !initialFeature ? features[0]?.name ?? null : null
}

/** Null means retain the current selection, including a pending run whose
 * index row has not arrived. A returned null runId instead clears the run. */
export function refreshedFeatureSelection(
  features: FeatureNames,
  runs: readonly RunIndexEntry[],
  selectedFeature: string | null,
  selectedRunId: string | null,
  preferredFeature?: string | null,
): { feature: string | null; runId: string | null } | null {
  if (preferredFeature && features.some((feature) => feature.name === preferredFeature)) {
    if (selectedFeature === preferredFeature && selectedRunId) return null
    return { feature: preferredFeature, runId: latestFeatureRunId(runs, preferredFeature) }
  }
  if (!selectedFeature || !features.some((feature) => feature.name === selectedFeature)) {
    const feature = features[0]?.name ?? null
    return { feature, runId: latestFeatureRunId(runs, feature) }
  }
  return null
}

export function reconcileRunSelection(
  selectedFeature: string | null,
  selectedRunId: string | null,
  pendingRunId: string | null,
  selectedRun: RunIndexEntry | null,
  latestRunId: string | null,
): { runId: string | null; pendingRunId: string | null } {
  if (!selectedFeature) return { runId: null, pendingRunId: null }
  if (selectedRun) {
    return { runId: selectedRunId, pendingRunId: pendingRunId === selectedRun.runId ? null : pendingRunId }
  }
  if (selectedRunId && pendingRunId === selectedRunId) return { runId: selectedRunId, pendingRunId }
  return { runId: latestRunId, pendingRunId }
}
