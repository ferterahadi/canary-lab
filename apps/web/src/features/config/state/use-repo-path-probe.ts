import * as api from '@/shared/api/client'
import { useLiveResource } from '@/shared/state/use-live-resource'

/** Machine-local probes are explicit reads, not configuration polling. */
export function useRepoPathProbe(path: string, remotePath: string | null) {
  const existence = useLiveResource(null, path || null, api.checkPathExists)
  const remote = useLiveResource(null, remotePath === path ? remotePath : null, api.getGitRemote)
  return { existence, remote }
}
