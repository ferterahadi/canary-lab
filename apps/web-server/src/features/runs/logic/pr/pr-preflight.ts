import { execFileSync } from 'child_process'
import { detectBaseBranch, resolveRepoPath } from '../../../../shared/git-repo'
import {
  detectGhStatus,
  detectRepoPushRights,
  parseGitHubRemote,
  type GhStatus,
  type RepoPushRights,
} from '../../../../shared/gh-cli'
import type { RunFixCapture } from '../../../../../../../shared/run-state'

// Side-effect-free "can we open a PR from this run's captured fix?" check, per
// repo. This is the enforcement point the PR dialog re-runs on open (auth can
// change outside the app), and it feeds the same taxonomy the Fixes-captured
// panel uses for its blocked-reason line.

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

export interface PrPreflightDeps {
  ghStatus?: () => Promise<GhStatus>
  pushRights?: (owner: string, name: string) => Promise<RepoPushRights>
  originUrl?: (repoRoot: string) => string | null
  baseBranch?: (repoRoot: string) => string | null
}

function defaultOriginUrl(repoRoot: string): string | null {
  try {
    return execFileSync('git', ['-C', repoRoot, 'config', '--get', 'remote.origin.url'], { encoding: 'utf-8' }).trim() || null
  } catch {
    return null
  }
}

export async function buildPrPreflight(fixCapture: RunFixCapture, deps: PrPreflightDeps = {}): Promise<PrPreflight> {
  const ghStatus = deps.ghStatus ?? detectGhStatus
  const pushRights = deps.pushRights ?? detectRepoPushRights
  const originUrl = deps.originUrl ?? defaultOriginUrl
  const baseBranch = deps.baseBranch ?? ((root: string) => detectBaseBranch(root))

  const gh = await ghStatus()
  const repos: PrRepoPreflight[] = []
  for (const fixRepo of fixCapture.repos) {
    const repoRoot = resolveRepoPath(fixRepo.repoRoot)
    const url = originUrl(repoRoot)
    const origin = url ? parseGitHubRemote(url) : null
    const base = baseBranch(repoRoot)
    const row: PrRepoPreflight = { repoName: fixRepo.repoName, repoRoot, origin, base, pushable: false }

    // gh drives github.com and GitHub Enterprise hosts (github.<company>.com),
    // but not gitlab/bitbucket — so github-ness is a host check, not just a
    // structural parse.
    const isGithub = !!origin && origin.host.includes('github')
    if (!url) {
      row.blocked = { reason: 'no-origin' }
    } else if (!isGithub) {
      row.blocked = { reason: 'not-github', detail: url }
    } else if (!gh.installed) {
      row.blocked = { reason: 'gh-missing' }
    } else if (!gh.authenticated) {
      row.blocked = { reason: 'not-authed' }
    } else {
      const rights = await pushRights(origin.owner, origin.name)
      if (rights.pushable) {
        row.pushable = true
      } else {
        row.blocked = {
          reason: 'wrong-account',
          detail: rights.reason ?? (gh.account ? `signed in as ${gh.account}, which can't push to ${origin.owner}/${origin.name}` : undefined),
        }
      }
    }
    repos.push(row)
  }
  return { gh, repos, anyPushable: repos.some((r) => r.pushable) }
}
