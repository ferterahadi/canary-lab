export function safeFilename(input: string): string {
  return input.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'run'
}

export function evaluationArchiveBase(feature: string, runId: string): string {
  return `canary-lab-evaluation-${safeFilename(feature)}-${safeFilename(runId)}`
}

export function evaluationArchiveFilename(feature: string, runId: string): string {
  return `${evaluationArchiveBase(feature, runId)}.zip`
}

// Persisted names are authoritative for historical tasks, including archives
// created before fallback names were standardized across export entry points.
export function evaluationTaskFilename(task: { archiveBase?: string; feature: string; runId: string }): string {
  return `${task.archiveBase ?? evaluationArchiveBase(task.feature, task.runId)}.zip`
}
