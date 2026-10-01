import type { RunDetail } from '../../../../../../shared/run-detail'

export function activeRunPriority(detail: RunDetail): number {
  if (detail.manifest.lifecycle?.phase === 'waiting-for-signal') return 0
  if (detail.manifest.status === 'healing') return 1
  return 2
}

export function compareActiveRuns(
  a: { detail: RunDetail; startedAt: string },
  b: { detail: RunDetail; startedAt: string },
): number {
  const priorityDiff = activeRunPriority(a.detail) - activeRunPriority(b.detail)
  if (priorityDiff !== 0) return priorityDiff
  return a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0
}
