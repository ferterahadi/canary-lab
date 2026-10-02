import * as workspaceApi from '@/shared/api/workspace'
import { useLiveResource } from '@/shared/state/use-live-resource'

/** Machine-local probes are explicit reads, not configuration polling. */
export function useRepoPathProbe(path: string, remotePath: string | null) {
  const existence = useLiveResource(null, path || null, workspaceApi.checkPathExists)
  const remote = useLiveResource(null, remotePath === path ? remotePath : null, workspaceApi.getGitRemote)
  return { existence, remote }
}
