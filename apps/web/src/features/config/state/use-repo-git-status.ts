import { REPOSITORY_FRESHNESS_MS, REPOSITORY_RECONCILE_MS, repositoryConsumerKey } from '@shared/repository-observation'
import { useInvalidationKey } from '@/shared/state/invalidation'
import { getRepoGitStatus } from '@/shared/api/client'
import { useLiveResource } from '@/shared/state/use-live-resource'

export function useRepoGitStatus(
  feature: string,
  repoName: string | undefined,
  opts: { enabled?: boolean; refreshKey?: number; localPath?: string } = {},
) {
  const globalVersion = useInvalidationKey('repos')
  const enabled = opts.enabled !== false && Boolean(feature && repoName)
    && (opts.localPath === undefined || opts.localPath.length > 0)
  // Local path participates in identity even though the endpoint resolves the
  // persisted repo: a response for the old folder must not label the new one.
  const key = enabled ? JSON.stringify([feature, repoName, opts.localPath]) : null
  const { value: status, ...resource } = useLiveResource('repos', key,
    (_key, readOpts) => getRepoGitStatus(feature, repoName!, readOpts), {
      scope: repositoryConsumerKey({ feature, repo: repoName ?? '' }),
      refreshKey: JSON.stringify([globalVersion, opts.refreshKey]),
      reconcileMs: REPOSITORY_RECONCILE_MS,
      leaseMs: REPOSITORY_FRESHNESS_MS,
      pauseWhenHidden: true,
    })
  return { status, ...resource }
}
