import type { RepoPrerequisite } from '../../../../shared/launcher/types'
import { getGitStatus, resolveRepoPath, runGit, type GitResult, type GitStatus } from './git-repo'

/**
 * Where a checkout stands against its remote-tracking branch. A feature pins a
 * repo to a branch, but the checkout stays on whatever commit was there when it
 * was set up — `git worktree add --detach HEAD` copies THAT commit, so a run of
 * a `main`-pinned feature boots a stale `main` for as long as nobody pulls.
 * These helpers give the agent the numbers to see that, and the one safe move
 * to fix it: a fast-forward that can never discard local work.
 */

export interface UpstreamStatus {
  /** The branch the counts describe — the checked-out one unless asked otherwise. */
  branch: string | null
  /** `origin/main`-style remote-tracking ref, or null when the branch has none. */
  upstream: string | null
  /** Commit the branch points at, null on an unborn branch or a non-repo. */
  branchSha: string | null
  upstreamSha: string | null
  /** Local commits the upstream lacks. Null when there is no upstream to count against. */
  aheadUpstream: number | null
  /** Upstream commits the checkout lacks — the staleness the agent is looking for. */
  behindUpstream: number | null
  /** Set when a fetch was requested and the remote could not be reached; the
   *  counts then describe the last successful fetch, not the remote's tip. */
  fetchError?: string
}

export type FastForwardRefusal =
  | 'not-a-git-repo'
  | 'detached'
  | 'wrong-branch'
  | 'dirty'
  | 'diverged'
  | 'fetch-failed'
  | 'merge-failed'

export type FastForwardOutcome =
  | { kind: 'fast-forwarded'; branch: string; upstream: string; from: string; to: string; behind: number }
  | { kind: 'up-to-date'; branch: string; upstream: string; sha: string }
  /** Local commits the upstream lacks and nothing to pull: a fast-forward is a
   *  no-op, not a failure — the checkout is simply ahead. */
  | { kind: 'ahead'; branch: string; upstream: string; sha: string; ahead: number }
  | { kind: 'no-upstream'; branch: string; sha: string | null }
  | { kind: 'refused'; reason: FastForwardRefusal; message: string; branch: string | null }

const emptyUpstream = (branch: string | null, branchSha: string | null): UpstreamStatus => ({
  branch,
  upstream: null,
  branchSha,
  upstreamSha: null,
  aheadUpstream: null,
  behindUpstream: null,
})

async function revParse(cwd: string, ref: string): Promise<string | null> {
  const res = await runGit(cwd, ['rev-parse', '--verify', '--quiet', ref])
  return res.code === 0 ? res.stdout.trim() : null
}

/** `origin/main` for `main`, or null when the branch tracks nothing. Git only
 *  resolves `@{upstream}` when the tracking ref actually exists, so a resolved
 *  name is safe to `rev-parse` and `rev-list` against afterwards. */
async function upstreamRef(cwd: string, branch: string): Promise<string | null> {
  const res = await runGit(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', `${branch}@{upstream}`])
  return res.code === 0 ? res.stdout.trim() : null
}

/** What a failed git command said — git always explains a non-zero exit on
 *  stderr, so this is the whole human-facing message. */
function gitError(res: GitResult): string {
  return res.stderr.trim()
}

/** `git fetch <remote> <branch>` for the branch's configured upstream — the
 *  remote-tracking ref moves as a side effect, so the counts below see the tip.
 *  Both config keys exist whenever `@{upstream}` resolved, which every caller
 *  checks first. */
async function fetchUpstream(cwd: string, branch: string): Promise<string | undefined> {
  const [remote, merge] = await Promise.all([
    runGit(cwd, ['config', '--get', `branch.${branch}.remote`]),
    runGit(cwd, ['config', '--get', `branch.${branch}.merge`]),
  ])
  const remoteBranch = merge.stdout.trim().replace(/^refs\/heads\//, '')
  const res = await runGit(cwd, ['fetch', '--quiet', remote.stdout.trim(), remoteBranch])
  return res.code === 0 ? undefined : gitError(res)
}

/** `ahead` = commits on the branch the upstream lacks; `behind` = the reverse.
 *  Both refs were resolved by the caller a moment ago, so `rev-list` has
 *  nothing to fail on; a repo mutated underneath us would surface as NaNs that
 *  no comparison below accepts, and the `--ff-only` merge then says why. */
async function aheadBehind(cwd: string, branch: string, upstream: string): Promise<{ ahead: number; behind: number }> {
  const res = await runGit(cwd, ['rev-list', '--left-right', '--count', `${branch}...${upstream}`])
  const [ahead, behind] = res.stdout.trim().split(/\s+/).map((n) => Number.parseInt(n, 10))
  return { ahead, behind }
}

/**
 * Compare a branch with its upstream. Local by default — the counts describe the
 * last fetch — so a status read never blocks on the network unless `fetch` is
 * asked for, in which case a failed fetch is reported alongside the stale counts
 * rather than replacing them.
 */
export async function getUpstreamStatus(
  repoPath: string,
  opts: { branch?: string; fetch?: boolean } = {},
): Promise<UpstreamStatus> {
  const target = resolveRepoPath(repoPath)
  const status = await getGitStatus(target)
  if (!status.isGitRepo) return emptyUpstream(null, null)
  const branch = opts.branch ?? status.currentBranch
  if (!branch) return emptyUpstream(null, status.headSha)
  const branchSha = await revParse(target, branch)
  const upstream = await upstreamRef(target, branch)
  if (!upstream) return emptyUpstream(branch, branchSha)
  const fetchError = opts.fetch ? await fetchUpstream(target, branch) : undefined
  const [upstreamSha, counts] = await Promise.all([revParse(target, upstream), aheadBehind(target, branch, upstream)])
  return {
    branch,
    upstream,
    branchSha,
    upstreamSha,
    aheadUpstream: counts.ahead,
    behindUpstream: counts.behind,
    ...(fetchError ? { fetchError } : {}),
  }
}

const refused = (reason: FastForwardRefusal, message: string, branch: string | null): FastForwardOutcome =>
  ({ kind: 'refused', reason, message, branch })

/**
 * Move a checkout to its upstream tip — only ever by fast-forward, and only when
 * doing so cannot lose anything: the checkout must be clean and sitting on the
 * branch (a detached HEAD or another branch means the caller's pin and the tree
 * disagree, which is the branch gate's job to report, not this one's to paper
 * over). Local commits the upstream lacks are left alone: `ahead` is a no-op and
 * `diverged` is a refusal, because merging or rebasing someone's unpushed work
 * is a decision they make, not a run-start side effect.
 *
 * `branch` defaults to the checked-out branch. `fetch` (default true) contacts
 * the remote first; without it the fast-forward targets whatever the last fetch
 * left in the remote-tracking ref.
 */
export async function fastForwardToUpstream(
  repoPath: string,
  opts: { branch?: string; fetch?: boolean } = {},
): Promise<FastForwardOutcome> {
  const target = resolveRepoPath(repoPath)
  const status = await getGitStatus(target)
  if (!status.isGitRepo) return refused('not-a-git-repo', `${target} is not a git repository`, null)
  if (status.detached) {
    return refused('detached', 'checkout is detached — check the pinned branch out first', null)
  }
  const branch = opts.branch ?? status.currentBranch!
  if (status.currentBranch !== branch) {
    return refused('wrong-branch', `checkout is on ${status.currentBranch}, not ${branch}`, status.currentBranch)
  }
  if (status.dirty) {
    return refused(
      'dirty',
      `checkout has uncommitted changes (${status.dirtyFiles.length} file(s)) — commit or stash them first`,
      branch,
    )
  }
  const upstream = await upstreamRef(target, branch)
  if (!upstream) return { kind: 'no-upstream', branch, sha: status.headSha }
  if (opts.fetch !== false) {
    const fetchError = await fetchUpstream(target, branch)
    if (fetchError) return refused('fetch-failed', `could not fetch ${upstream}: ${fetchError}`, branch)
  }
  const counts = await aheadBehind(target, branch, upstream)
  const sha = status.headSha!
  if (counts.ahead > 0 && counts.behind > 0) {
    return refused(
      'diverged',
      `${branch} has ${counts.ahead} local commit(s) the upstream lacks and is ${counts.behind} behind ${upstream} — reconcile by hand`,
      branch,
    )
  }
  if (counts.ahead > 0) return { kind: 'ahead', branch, upstream, sha, ahead: counts.ahead }
  if (counts.behind === 0) return { kind: 'up-to-date', branch, upstream, sha }
  const merged = await runGit(target, ['merge', '--ff-only', '--quiet', upstream])
  // Reachable even on a clean, strictly-behind checkout — git could not write
  // the incoming files (permissions, disk) — and HEAD stays put when it is.
  if (merged.code !== 0) return refused('merge-failed', gitError(merged), branch)
  const to = (await revParse(target, 'HEAD'))!
  return { kind: 'fast-forwarded', branch, upstream, from: sha, to, behind: counts.behind }
}

/** One human line per outcome — what the runner log and the tool result say. */
export function describeFastForward(outcome: FastForwardOutcome): string {
  switch (outcome.kind) {
    case 'fast-forwarded':
      return `fast-forwarded ${outcome.branch} ${outcome.from.slice(0, 7)} → ${outcome.to.slice(0, 7)} (${outcome.behind} commit(s) from ${outcome.upstream})`
    case 'up-to-date':
      return `${outcome.branch} already at ${outcome.upstream} (${outcome.sha.slice(0, 7)})`
    case 'ahead':
      return `${outcome.branch} is ${outcome.ahead} commit(s) ahead of ${outcome.upstream}; nothing to pull`
    case 'no-upstream':
      return `${outcome.branch} tracks no upstream; booting the checked-out commit`
    case 'refused':
      return `refused (${outcome.reason}): ${outcome.message}`
  }
}

/** The repo-status payload both the REST git route and the MCP status tool
 *  return: the checkout's git status, where it stands against its upstream, and
 *  what the feature config expects of it. */
export type RepoCheckoutStatus = GitStatus &
  UpstreamStatus & { path: string; expectedBranch: string | null; trackUpstream: boolean }

export async function describeRepoCheckout(
  repo: RepoPrerequisite,
  opts: { fetch?: boolean } = {},
): Promise<RepoCheckoutStatus> {
  const status = await getGitStatus(repo.localPath)
  const upstream = status.isGitRepo
    ? await getUpstreamStatus(repo.localPath, { branch: repo.branch, fetch: opts.fetch })
    : emptyUpstream(null, null)
  return {
    ...status,
    ...upstream,
    path: resolveRepoPath(repo.localPath),
    expectedBranch: repo.branch ?? null,
    trackUpstream: repo.track === 'upstream',
  }
}
