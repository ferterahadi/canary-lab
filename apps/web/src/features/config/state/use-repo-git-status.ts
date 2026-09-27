import { getRepoGitStatus } from '@/shared/api/client'
import { useLiveResource } from '@/shared/state/use-live-resource'

export function useRepoGitStatus(
  feature: string,
  repoName: string | undefined,
  opts: { enabled?: boolean; refreshKey?: number; localPath?: string } = {},
) {
  const enabled = opts.enabled !== false && Boolean(feature && repoName)
    && (opts.localPath === undefined || opts.localPath.length > 0)
  // Local path participates in identity even though the endpoint resolves the
  // persisted repo: a response for the old folder must not label the new one.
  const key = enabled ? JSON.stringify([feature, repoName, opts.localPath]) : null
  const { value: status, ...resource } = useLiveResource('repos', key,
    () => getRepoGitStatus(feature, repoName!), {
      refreshKey: opts.refreshKey,
      reconcileMs: 5000,
      leaseMs: 15000,
    })
  return { status, ...resource }
}
