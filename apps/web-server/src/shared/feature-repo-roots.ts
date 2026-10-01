import { loadFeatures } from './feature-loader'
import { getGitRoot } from './git-repo'
import { resolveRepoPath } from './repo-identity'

// Cleanup scans source repositories, not the individual worktrees declared by
// suites. Several suites may resolve to the same Git toplevel.
export async function featureRepoRoots(featuresDir: string): Promise<string[]> {
  const roots = new Set<string>()
  for (const feature of loadFeatures(featuresDir)) {
    for (const repo of feature.repos ?? []) {
      try {
        const root = await getGitRoot(resolveRepoPath(repo.localPath))
        if (root) roots.add(root)
      } catch { /* skip repos that aren't resolvable */ }
    }
  }
  return [...roots]
}
