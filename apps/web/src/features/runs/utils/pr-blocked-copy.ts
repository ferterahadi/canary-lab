import type { PrBlockedReason } from '@/shared/api/client'

// The one home for "why this repo can't get a pull request" in prose.
//
// The preflight's verdict travels as a machine code (`no-origin`), and a run's
// attempt record stores that same code as its failure reason — so the dialog and
// the repo card were both handed an enum where a sentence belongs. The dialog
// already had the sentences; this is that map, moved somewhere the card can
// reach it, rather than a second copy drifting on the card.

export const BLOCKED_HELP: Record<PrBlockedReason, { line: string; command?: string }> = {
  'no-origin': { line: 'This repo has no `origin` remote — a PR needs one.' },
  'not-github': { line: 'The origin remote isn’t a GitHub repo, so gh can’t open a PR.' },
  'gh-missing': { line: 'The GitHub CLI isn’t installed.', command: 'brew install gh' },
  'not-authed': { line: 'You’re not signed in to GitHub.', command: 'gh auth login --hostname github.com --web' },
  'wrong-account': { line: 'The signed-in account can’t push to this repo.', command: 'gh auth switch' },
}

/**
 * Prose for an attempt's failure reason.
 *
 * A reason that isn't a preflight code is already a sentence written by the
 * failing step (`gh pr create returned no URL`), so it passes through — the
 * point is to stop printing enums, not to swallow anything unrecognized.
 */
export function prBlockedLine(reason: string): string {
  return reason in BLOCKED_HELP ? BLOCKED_HELP[reason as PrBlockedReason].line : reason
}
