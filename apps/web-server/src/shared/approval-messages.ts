/** Shared questions for decisions offered by more than one workflow. */
export function portifyReviewMessage(feature: string): string {
  return `Review the port changes for "${feature}". Save them for future runs, request changes, or discard them? Your app's source code stays unchanged. Discarding keeps runs one at a time.`
}

export function repositoryIsolationMessage(conflictingFeature: string): string {
  return `"${conflictingFeature}" is already using this app. Start in a separate copy (worktree), or wait (queue)?`
}
