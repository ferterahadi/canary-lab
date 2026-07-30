import { transition, type DraftRecord } from '../logic/draft-store'
import { publishWorkspaceEvent } from '../../../shared/workspace-events'
import type { TestsDraftRouteDeps } from './tests-draft'

// `planning`/`generating` are the two statuses an authoring session can be
// interrupted from. External drafts report `generating` for every stage before
// ready/applied (statusForExternalStage in mcp/tool-support.ts), so this is what
// gates cancel-generation.
export function isTransientGenerationStatus(status: DraftRecord['status']): boolean {
  return status === 'planning' || status === 'generating'
}

export function transitionDraft(
  deps: TestsDraftRouteDeps,
  draftId: string,
  status: DraftRecord['status'],
  patch?: Partial<DraftRecord>,
): DraftRecord {
  const next = transition(deps.logsDir, draftId, status, patch)
  publishWorkspaceEvent(deps.workspaceEvents, { type: 'draft-updated', draft: next })
  return next
}
