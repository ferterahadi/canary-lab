import type { FeatureConfig, RepoPrerequisite } from '../../../../../../../shared/launcher/types'
import { resolveRepoPath, type RepoBranchSnapshot } from '../../../../shared/git-repo'
import { describeFastForward, fastForwardToUpstream, type FastForwardOutcome, type FastForwardRefusal } from '../../../../shared/git-upstream'

/**
 * Run-start half of upstream tracking: decide which of a feature's repos get
 * fast-forwarded before the run boots, do it, and turn any refusal into the
 * typed 409 the routes already know how to surface (`repo_update_refused`,
 * sibling of `repo_branch_mismatch`). The git mechanics live in
 * `shared/git-upstream.ts`; this module only owns the per-run policy.
 */

/** One repo the run refused to update, in the shape the start_run result carries. */
export interface RepoUpdateRefusal {
  name: string
  path: string
  branch: string | null
  reason: FastForwardRefusal | 'in-use'
  message: string
}

/** Per-repo outcome of the pre-boot update, keyed by repo name. */
export type RepoUpdateReport = Record<string, FastForwardOutcome>

/**
 * `updateRepos` is the run's one-shot choice: `true` updates every repo,
 * `false` updates none, and leaving it unset defers to each repo's own
 * `track: 'upstream'` setting — the default a feature owner set in config.
 */
export function reposToUpdate(feature: FeatureConfig, updateRepos: boolean | undefined): RepoPrerequisite[] {
  if (updateRepos === false) return []
  return (feature.repos ?? []).filter((repo) =>
    typeof repo.localPath === 'string' && (updateRepos === true || repo.track === 'upstream'))
}

/**
 * Fast-forward the selected repos. Refusals are collected — every repo is
 * checked, so the caller sees all of them at once — and thrown as one 409 that
 * names each one; nothing has been allocated yet at this point in run start, so
 * there is nothing to unwind. A repo an active in-place run is booted from is
 * refused too: moving its files underneath live services is not a safe update,
 * and the collision prompt is the caller's tool for that.
 */
export async function updateReposToUpstream(
  feature: FeatureConfig,
  updateRepos: boolean | undefined,
  opts: { inUseBy: (repoPath: string) => string | null },
): Promise<RepoUpdateReport> {
  const report: RepoUpdateReport = {}
  const refusals: RepoUpdateRefusal[] = []
  for (const repo of reposToUpdate(feature, updateRepos)) {
    const repoPath = resolveRepoPath(repo.localPath)
    const holder = opts.inUseBy(repoPath)
    if (holder) {
      refusals.push({
        name: repo.name,
        path: repoPath,
        branch: repo.branch ?? null,
        reason: 'in-use',
        message: `run ${holder} is booted from this checkout in place; wait for it or queue behind it`,
      })
      continue
    }
    const outcome = await fastForwardToUpstream(repoPath, { branch: repo.branch })
    report[repo.name] = outcome
    if (outcome.kind === 'refused') {
      refusals.push({ name: repo.name, path: repoPath, branch: outcome.branch, reason: outcome.reason, message: outcome.message })
    }
  }
  if (refusals.length > 0) {
    const lines = refusals.map((r) => `${r.name}: ${r.message}`)
    // `repoUpdate` rides beside the human message the same way `branchMismatch`
    // does, so the REST route can type the 409 and MCP can relay the rows.
    throw Object.assign(
      new Error(`Repo upstream update refused:\n${lines.join('\n')}`),
      { statusCode: 409, repoUpdate: refusals },
    )
  }
  return report
}

/** The fast-forwards that actually moved a checkout, in the snapshot's shape. */
export function updatedFromUpstreamByRepo(report: RepoUpdateReport): Record<string, RepoBranchSnapshot['updatedFromUpstream']> {
  const out: Record<string, RepoBranchSnapshot['updatedFromUpstream']> = {}
  for (const [name, outcome] of Object.entries(report)) {
    if (outcome.kind === 'fast-forwarded') out[name] = { upstream: outcome.upstream, from: outcome.from, to: outcome.to }
  }
  return out
}

/** Runner-log lines, one per repo the run looked at. */
export function describeRepoUpdates(report: RepoUpdateReport): string[] {
  return Object.entries(report).map(([name, outcome]) => `Upstream update for "${name}": ${describeFastForward(outcome)}`)
}
