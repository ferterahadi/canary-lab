import type { ApprovalDisplay } from '../../../../shared/approval'

/** Shared questions for decisions offered by more than one workflow. */
export function portifyReviewMessage(feature: string): string {
  return `Review the port changes for "${feature}". Save them for future runs, request changes, or discard them? Your app's source code stays unchanged. Discarding keeps runs one at a time.`
}

export const PORTIFY_REVIEW_DISPLAY: ApprovalDisplay = {
  title: 'Port changes ready',
  choices: {
    save: { label: 'Save', detail: 'Keeps the port changes for future runs.' },
    revise: { label: 'Request changes', detail: 'Sends your feedback for another attempt.' },
    discard: { label: 'Discard', detail: 'Drops the changes. Runs stay one at a time.' },
  },
}

export function repositoryIsolationMessage(conflictingFeature: string): string {
  return `"${conflictingFeature}" is already using this app. Start in a separate copy (worktree), or wait (queue)?`
}

export const REPOSITORY_ISOLATION_DISPLAY: ApprovalDisplay = {
  title: 'Another suite is using this app',
  choices: {
    worktree: { label: 'Separate copy', detail: 'Starts now in its own worktree of the app.' },
    queue: { label: 'Wait', detail: 'Starts automatically when the other suite finishes.' },
  },
}
