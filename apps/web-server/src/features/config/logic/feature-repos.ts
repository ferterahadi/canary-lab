import type { RepositoryObserver } from '../../../shared/repository-observer'
import type { RepoPrerequisite } from '../../../../../../shared/launcher/types'
import { loadFeatures } from '../../../shared/feature-loader'
import { checkoutBranch, findRepo, resolveRepoPath, type GitStatus } from '../../../shared/git-repo'
import { describeFastForward, describeRepoCheckout, fastForwardToUpstream, type RepoCheckoutStatus } from '../../../shared/git-upstream'
import { publishWorkspaceEvent, type WorkspaceEventPublisher } from '../../../shared/workspace-events'

export interface FeatureRepoDeps {
  repositoryObserver?: RepositoryObserver
  featuresDir: string
  workspaceEvents?: WorkspaceEventPublisher
  isRepoActive?: (feature: string, repo: string) => boolean
}

type RepoResult<T> = { ok: true; value: T } | { ok: false; statusCode: number; error: string; reason?: string }
type RepoTarget = { feature: string; repo: string }

function resolveRepo(deps: FeatureRepoDeps, target: RepoTarget, mutation: boolean): RepoResult<RepoPrerequisite> {
  const feature = loadFeatures(deps.featuresDir).find((entry) => entry.name === target.feature)
  if (!feature) return { ok: false, statusCode: 404, error: 'feature not found' }
  const repo = findRepo(feature, target.repo)
  if (!repo) return { ok: false, statusCode: 404, error: 'repo not found' }
  if (mutation && deps.isRepoActive?.(feature.name, repo.name)) {
    return { ok: false, statusCode: 409, error: 'repo has an active service run' }
  }
  return { ok: true, value: repo }
}

export async function readFeatureRepo(deps: FeatureRepoDeps, target: RepoTarget, opts: { fetch?: boolean } = {}): Promise<RepoResult<RepoCheckoutStatus>> {
  const resolved = resolveRepo(deps, target, false)
  if (!resolved.ok) return resolved
  const value = deps.repositoryObserver
    ? await deps.repositoryObserver.readRepo(resolved.value, target, opts)
    : await describeRepoCheckout(resolved.value, opts)
  return { ok: true, value }
}

export async function updateFeatureRepo(deps: FeatureRepoDeps, target: RepoTarget) {
  const resolved = resolveRepo(deps, target, true)
  if (!resolved.ok) return resolved
  const repo = resolved.value
  const outcome = await fastForwardToUpstream(repo.localPath, { branch: repo.branch })
  if (outcome.kind === 'refused') {
    return { ok: false as const, statusCode: 409, error: `${outcome.reason}: ${outcome.message}`, reason: outcome.reason }
  }
  if (outcome.kind === 'fast-forwarded') publishWorkspaceEvent(deps.workspaceEvents, { type: 'features-changed' })
  return { ok: true as const, value: { update: outcome, summary: describeFastForward(outcome), ...await describeRepoCheckout(repo) } }
}

export async function checkoutFeatureRepo(deps: FeatureRepoDeps, target: RepoTarget & { branch: string }): Promise<RepoResult<GitStatus & { path: string; expectedBranch: string | null }>> {
  const resolved = resolveRepo(deps, target, true)
  if (!resolved.ok) return resolved
  const repo = resolved.value
  try {
    // The Git writer announces actual moves, including callers outside suites.
    // No-op checkouts must not acquire a second, adapter-owned announcement.
    const status = await checkoutBranch(repo.localPath, target.branch.trim(), deps.workspaceEvents)
    return { ok: true, value: { ...status, path: resolveRepoPath(repo.localPath), expectedBranch: repo.branch ?? null } }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      statusCode: typeof (err as { statusCode?: unknown }).statusCode === 'number' ? (err as { statusCode: number }).statusCode : 500,
    }
  }
}
