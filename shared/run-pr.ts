import type { RunProposedPr } from './run-state'

export interface GhStatus {
  /** `gh` is on PATH. */
  installed: boolean
  /** A stored credential exists for the host (from `gh auth status`, local — no
   *  network call, and the token itself is masked and never captured). */
  authenticated: boolean
  /** The signed-in GitHub login, when it could be parsed. */
  account?: string
  /** The host the account is on (github.com or an enterprise host). */
  host?: string
}

export type PrBlockedReason =
  | 'no-origin'      // the repo has no `origin` remote
  | 'not-github'     // origin isn't a GitHub remote we recognize
  | 'gh-missing'     // the gh CLI isn't installed
  | 'not-authed'     // gh is installed but no account is signed in
  | 'wrong-account'  // signed in, but the account can't push to this repo

export interface PrRepoPreflight {
  repoName: string
  repoRoot: string
  origin: { owner: string; name: string; host: string } | null
  base: string | null
  pushable: boolean
  blocked?: { reason: PrBlockedReason; detail?: string }
}

export interface PrPreflight {
  gh: GhStatus
  repos: PrRepoPreflight[]
  /** At least one repo is pushable — the dialog can offer a PR. */
  anyPushable: boolean
}

export interface ProposePrResult {
  repoName: string
  ok: boolean
  pr?: RunProposedPr
  /** Why it didn't open, when `ok` is false (conflict, push rejected, etc.). */
  reason?: string
}
