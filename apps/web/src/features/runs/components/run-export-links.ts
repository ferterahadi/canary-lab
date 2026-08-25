import type { PlaywrightArtifactGroup } from '@/shared/api/types'
import { evaluationArchiveFilename } from '@/shared/lib/format'
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
  const documentRef = opts.documentRef ?? document
  const urlApi = opts.urlApi ?? URL
  const res = await fetchImpl(evaluationHref(runId))
  if (!res.ok) throw new Error(`evaluation export failed: HTTP ${res.status}`)
  const href = urlApi.createObjectURL(await res.blob())
  const link = documentRef.createElement('a')
  try {
    link.href = href
    link.download = evaluationFilename(feature, runId)
    link.style.display = 'none'
    documentRef.body.appendChild(link)
    link.click()
  } finally {
    link.remove()
    urlApi.revokeObjectURL(href)
  }
}

export function hasAssertionVideos(groups: PlaywrightArtifactGroup[] | undefined): boolean {
  return groups?.some((group) => group.artifacts.some((artifact) => artifact.kind === 'video')) ?? false
}

export { safeFilename } from '@/shared/lib/format'
