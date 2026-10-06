import { downloadBlob } from '@/shared/lib/download'
import type { PlaywrightArtifactGroup } from '@shared/run-detail'
import { evaluationArchiveFilename } from '@shared/evaluation-archive-naming'
import { isTerminalRunStatus as isSharedTerminalRunStatus } from '@shared/run-state'

// Run has reached a terminal state — the agent pty is gone, so the live
// xterm pane has nothing to subscribe to. Switch to the structured-view
// historical replay (which reads the agent CLI's own JSONL session log).
export function isTerminalRunStatus(status: string): boolean {
  return isSharedTerminalRunStatus(status)
}

export function isAssertionExportable(status: string): boolean {
  return isSharedTerminalRunStatus(status)
}

export function isEvaluationExportable(status: string): boolean {
  return isAssertionExportable(status)
}

export function assertionFilename(feature: string, runId: string): string {
  return evaluationFilename(feature, runId)
}

export function assertionHref(runId: string): string {
  return evaluationHref(runId)
}

export function evaluationFilename(feature: string, runId: string): string {
  return evaluationArchiveFilename(feature, runId)
}

export function evaluationHref(runId: string): string {
  return `/api/runs/${encodeURIComponent(runId)}/evaluation.html`
}

export async function downloadEvaluationReport(
  feature: string,
  runId: string,
  opts: {
    fetchImpl?: typeof fetch
    documentRef?: Document
    urlApi?: Pick<typeof URL, 'createObjectURL' | 'revokeObjectURL'>
  } = {},
): Promise<void> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const res = await fetchImpl(evaluationHref(runId))
  if (!res.ok) throw new Error(`evaluation export failed: HTTP ${res.status}`)
  downloadBlob(await res.blob(), evaluationFilename(feature, runId), opts)

}

export function hasAssertionVideos(groups: PlaywrightArtifactGroup[] | undefined): boolean {
  return groups?.some((group) => group.artifacts.some((artifact) => artifact.kind === 'video')) ?? false
}
